import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { httpJson, HttpError, RateLimiter, sleep } from '../http.js';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

/**
 * The outcome of a quote request, kept as three distinct cases on purpose.
 *
 * Collapsing 'fault' into 'no_route' is not a cosmetic bug: it reports a
 * throttled client as a drained pool, which are opposite diagnoses and lead to
 * opposite actions (slow down vs. get out now). On 2026-08-15 that mislabelling
 * turned 2,316 HTTP 429s into "no Jupiter route" and, live, would have read as
 * three unsellable bags.
 */
export type QuoteResult =
  | { ok: true; quote: JupiterQuote }
  | { ok: false; kind: 'no_route' }
  | { ok: false; kind: 'fault'; error: string; status: number | null };

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  /** Absent on some single-hop responses. The quote is echoed back verbatim, so it is never read. */
  routePlan?: unknown[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface SwapResult {
  signature: string;
  /** True only once the network confirmed it. A signature alone is not a fill. */
  confirmed: boolean;
  /** Raw base units actually received, read back from the confirmed transaction. */
  outAmountRaw: bigint;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

export class JupiterClient {
  private readonly base: string;
  private readonly authHeaders: Record<string, string>;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly cfg: Config,
    private readonly connection: Connection,
  ) {
    // Trailing slashes here produce a 404 that reads like a dead endpoint.
    this.base = cfg.jupiterBaseUrl.replace(/\/+$/, '');
    this.authHeaders = cfg.jupiterApiKey ? { 'x-api-key': cfg.jupiterApiKey } : {};
    // Budget is configurable because the keyless tier's real limit is not
    // published in a form worth hardcoding — it is tuned from observed 429s.
    // Burst is a quarter of the per-minute budget so a poll cycle over several
    // open positions does not empty the bucket in one go.
    const perMin = Math.max(1, cfg.jupiterMaxReqPerMin);
    this.limiter = new RateLimiter(
      Math.max(1, Math.ceil(perMin / 4)),
      perMin / 60,
      'jupiter',
    );
  }

  /**
   * Distinguishes "this token has no route" (an ordinary outcome — dead pool,
   * honeypot, paused market) from "I could not ask" (throttled, timed out,
   * upstream down). Callers must handle both; see QuoteResult.
   */
  async quote(params: {
    inputMint: string;
    outputMint: string;
    amountRaw: bigint;
    slippageBps: number;
  }): Promise<QuoteResult> {
    const url =
      `${this.base}/quote` +
      `?inputMint=${params.inputMint}` +
      `&outputMint=${params.outputMint}` +
      `&amount=${params.amountRaw.toString()}` +
      `&slippageBps=${params.slippageBps}` +
      `&onlyDirectRoutes=false` +
      `&asLegacyTransaction=false`;

    try {
      const q = await httpJson<JupiterQuote>(url, {
        label: 'jupiter.quote',
        limiter: this.limiter,
        retries: 2,
        timeoutMs: 10_000,
        headers: this.authHeaders,
      });
      if (!q?.outAmount || BigInt(q.outAmount) <= 0n) {
        return { ok: false, kind: 'no_route' };
      }
      return { ok: true, quote: q };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : null;
      const bodyText = err instanceof HttpError ? (err.bodyText ?? '') : '';
      const error = err instanceof Error ? err.message : String(err);

      // Jupiter answers an unroutable pair with 400 and a body saying so. That
      // is a real answer, not a failure to ask, so it stays 'no_route' —
      // otherwise dead tokens would be retried forever as if they were faults.
      if (status === 400 && /no route|not found|could not find/i.test(bodyText)) {
        return { ok: false, kind: 'no_route' };
      }

      logger.debug('QUOTE_FAULT', {
        input: params.inputMint,
        output: params.outputMint,
        status,
        error,
      });
      return { ok: false, kind: 'fault', error, status };
    }
  }

  /** Builds, signs, submits and confirms the swap. Throws on any failure. */
  async swap(keypair: Keypair, quote: JupiterQuote): Promise<SwapResult> {
    const swapRes = await httpJson<SwapResponse>(`${this.base}/swap`, {
      method: 'POST',
      label: 'jupiter.swap',
      limiter: this.limiter,
      retries: 2,
      timeoutMs: 20_000,
      headers: this.authHeaders,
      body: {
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: this.cfg.priorityFeeLamports,
      },
    });

    if (!swapRes?.swapTransaction) {
      throw new Error('Jupiter returned no swapTransaction');
    }

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapRes.swapTransaction, 'base64'),
    );
    tx.sign([keypair]);

    // skipPreflight because simulation against a pool moving this fast fails on
    // stale state far more often than the send itself does.
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });

    logger.debug('TX_SUBMITTED', { signature });

    const confirmed = await this.confirm(signature, swapRes.lastValidBlockHeight);
    if (!confirmed) {
      throw new Error(`Transaction ${signature} was not confirmed before blockhash expiry`);
    }

    const outAmountRaw = await this.readOutAmount(signature, keypair, quote.outputMint);

    return { signature, confirmed: true, outAmountRaw };
  }

  private async confirm(signature: string, lastValidBlockHeight?: number): Promise<boolean> {
    const deadline = Date.now() + 90_000;

    while (Date.now() < deadline) {
      const status = await this.connection
        .getSignatureStatus(signature, { searchTransactionHistory: false })
        .catch(() => null);

      const value = status?.value;
      if (value) {
        if (value.err) {
          throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(value.err)}`);
        }
        if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
          return true;
        }
      }

      // Once the blockhash can no longer land, the transaction is dead for good.
      if (lastValidBlockHeight !== undefined) {
        const height = await this.connection.getBlockHeight('confirmed').catch(() => null);
        if (height !== null && height > lastValidBlockHeight) return false;
      }

      await sleep(1_500);
    }

    return false;
  }

  /**
   * The quote's outAmount is an estimate. The number that matters for P&L is the
   * balance the wallet actually gained, so it is read back from the confirmed
   * transaction's token balance deltas.
   */
  private async readOutAmount(
    signature: string,
    keypair: Keypair,
    outputMint: string,
  ): Promise<bigint> {
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const pre = tx?.meta?.preTokenBalances ?? [];
      const post = tx?.meta?.postTokenBalances ?? [];
      const owner = keypair.publicKey.toBase58();

      const sum = (
        entries: typeof pre,
      ): bigint =>
        entries
          .filter((b) => b.mint === outputMint && b.owner === owner)
          .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount ?? '0'), 0n);

      const delta = sum(post) - sum(pre);
      return delta > 0n ? delta : 0n;
    } catch (err) {
      logger.warn('OUT_AMOUNT_READBACK_FAILED', {
        signature,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0n;
    }
  }
}
