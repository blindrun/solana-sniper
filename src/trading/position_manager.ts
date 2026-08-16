import type { Keypair } from '@solana/web3.js';
import { USDC_DECIMALS, USDC_MINT, type Config } from '../config.js';
import type { ScoreResult } from '../discovery/scorer.js';
import { logger } from '../logger.js';
import {
  round,
  type ClosedTrade,
  type ExitReason,
  type Position,
  type StateManager,
} from '../state/state_manager.js';
import type { Wallet } from '../wallet/wallet.js';
import { sleep } from '../http.js';
import type { JupiterClient } from './jupiter.js';

const SELL_ATTEMPTS = 3;

/**
 * Result of pricing a held position. 'fault' means the bot could not ask;
 * 'no_route' means it asked and the market had no answer. Treating the first as
 * the second is what made three throttled positions look like drained pools.
 */
export type MarkResult =
  | { ok: true; price: number; valueUsdc: number }
  | { ok: false; kind: 'no_route' | 'empty' }
  | { ok: false; kind: 'fault'; error: string; status: number | null };

function toRaw(amount: number, decimals: number): bigint {
  // Route through a string to avoid float artefacts on 9-decimal mints.
  return BigInt(Math.floor(amount * 10 ** decimals));
}

function fromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export interface BuyBlockedReason {
  blocked: true;
  reason: string;
  detail?: Record<string, unknown>;
}

export class PositionManager {
  /** Mints currently mid-trade, so the poll loop and the buy loop cannot collide. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly cfg: Config,
    private readonly state: StateManager,
    private readonly jupiter: JupiterClient,
    private readonly wallet: Wallet,
    private readonly keypair: Keypair,
  ) {}

  isInFlight(mint: string): boolean {
    return this.inFlight.has(mint);
  }

  /**
   * Every hard rail is checked here, before a quote is even requested. Returns
   * null when the buy is allowed.
   */
  async checkBuyAllowed(): Promise<BuyBlockedReason | null> {
    const positions = this.state.getPositions();
    if (positions.length >= this.cfg.maxPositions) {
      return {
        blocked: true,
        reason: 'max_positions',
        detail: { open: positions.length, max: this.cfg.maxPositions },
      };
    }

    const daily = this.state.getDaily();

    if (daily.spentUsdc + this.cfg.positionSizeUsdc > this.cfg.maxDailySpendUsdc) {
      return {
        blocked: true,
        reason: 'max_daily_spend',
        detail: { spent_usdc: round(daily.spentUsdc), cap_usdc: this.cfg.maxDailySpendUsdc },
      };
    }

    if (daily.realizedPnlUsdc <= -this.cfg.maxDailyLossUsdc) {
      return {
        blocked: true,
        reason: 'max_daily_loss',
        detail: {
          realized_pnl_usdc: round(daily.realizedPnlUsdc),
          cap_usdc: this.cfg.maxDailyLossUsdc,
        },
      };
    }

    // In DRY_RUN with no funded wallet the balances are meaningless, so they are
    // reported but not enforced — otherwise a paper run could never place a trade.
    const enforceBalances = !this.cfg.dryRun;

    let usdc = 0;
    let sol = 0;
    try {
      [usdc, sol] = await Promise.all([this.wallet.usdcBalance(), this.wallet.solBalance()]);
    } catch (err) {
      if (enforceBalances) {
        return {
          blocked: true,
          reason: 'balance_check_failed',
          detail: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    const requiredUsdc = this.cfg.positionSizeUsdc * 1.1;
    if (enforceBalances && usdc < requiredUsdc) {
      return {
        blocked: true,
        reason: 'insufficient_usdc',
        detail: { usdc: round(usdc, 2), required: round(requiredUsdc, 2) },
      };
    }
    if (enforceBalances && sol < this.cfg.minSolBalance) {
      return {
        blocked: true,
        reason: 'insufficient_sol_for_fees',
        detail: { sol: round(sol, 4), required: this.cfg.minSolBalance },
      };
    }

    return null;
  }

  async buy(score: ScoreResult): Promise<boolean> {
    const mint = score.mint;
    if (this.inFlight.has(mint)) return false;
    if (this.state.holdsPosition(mint)) return false;

    const decimals = score.mintInfo?.decimals ?? 0;
    const pair = score.pair;
    if (!pair) return false;

    this.inFlight.add(mint);
    try {
      const amountRaw = toRaw(this.cfg.positionSizeUsdc, USDC_DECIMALS);
      const quoteRes = await this.jupiter.quote({
        inputMint: USDC_MINT,
        outputMint: mint,
        amountRaw,
        slippageBps: this.cfg.slippageBps,
      });

      if (!quoteRes.ok) {
        if (quoteRes.kind === 'fault') {
          logger.warn('BUY_BLOCKED', {
            mint,
            reason: 'quote_fault',
            status: quoteRes.status,
            error: quoteRes.error,
            note: 'Could not reach Jupiter. Not a verdict on the token — no buy.',
          });
        } else {
          logger.warn('BUY_NO_ROUTE', { mint, usdc_in: this.cfg.positionSizeUsdc });
        }
        return false;
      }
      const quote = quoteRes.quote;

      const quotedOutRaw = BigInt(quote.outAmount);

      // Exit-side sanity check: price the sell before committing to the buy.
      // Being able to buy a token says nothing about being able to get out of it
      // at a comparable price. This one check catches transfer-fee honeypots,
      // one-sided pools, and pools simply too thin for this position size —
      // failure modes that every metadata-based filter above passes cleanly.
      const roundTripRes = await this.jupiter.quote({
        inputMint: mint,
        outputMint: USDC_MINT,
        amountRaw: quotedOutRaw,
        slippageBps: this.cfg.sellSlippageBps,
      });

      if (!roundTripRes.ok) {
        // Both cases refuse the buy, but for different reasons worth telling
        // apart: one is a bad token, the other is a blind bot. Never enter a
        // position whose exit could not be verified.
        logger.warn('TOKEN_SKIPPED', {
          mint,
          reason:
            roundTripRes.kind === 'fault' ? 'exit_check_unavailable' : 'no_exit_route',
          ...(roundTripRes.kind === 'fault'
            ? { status: roundTripRes.status, error: roundTripRes.error }
            : {}),
          note:
            roundTripRes.kind === 'fault'
              ? 'Could not price the exit. Refusing to enter unverified.'
              : 'Buy routes but sell does not. Refusing to enter a position with no exit.',
        });
        return false;
      }
      const roundTrip = roundTripRes.quote;

      const usdcBack = fromRaw(BigInt(roundTrip.outAmount), USDC_DECIMALS);
      const roundTripLossPct = (1 - usdcBack / this.cfg.positionSizeUsdc) * 100;

      if (roundTripLossPct > this.cfg.maxRoundTripLossPct) {
        logger.warn('TOKEN_SKIPPED', {
          mint,
          symbol: pair.baseToken.symbol,
          reason: 'round_trip_loss_excessive',
          usdc_in: this.cfg.positionSizeUsdc,
          usdc_back_immediately: round(usdcBack, 4),
          round_trip_loss_pct: round(roundTripLossPct, 2),
          limit_pct: this.cfg.maxRoundTripLossPct,
        });
        return false;
      }

      logger.debug('ROUND_TRIP_OK', {
        mint,
        round_trip_loss_pct: round(roundTripLossPct, 2),
      });

      let tokensOutRaw = quotedOutRaw;
      let buyTx: string | null = null;

      if (this.cfg.dryRun) {
        logger.info('BUY_EXECUTED', {
          mint,
          symbol: pair.baseToken.symbol,
          usdc_in: this.cfg.positionSizeUsdc,
          tokens_out: fromRaw(tokensOutRaw, decimals),
          price: round(this.cfg.positionSizeUsdc / fromRaw(tokensOutRaw, decimals), 12),
          price_impact_pct: quote.priceImpactPct,
          tx: null,
          dry_run: true,
        });
      } else {
        const result = await this.jupiter.swap(this.keypair, quote);
        buyTx = result.signature;
        // Prefer the on-chain delta; fall back to the quote if the readback failed.
        tokensOutRaw = result.outAmountRaw > 0n ? result.outAmountRaw : quotedOutRaw;

        logger.info('BUY_EXECUTED', {
          mint,
          symbol: pair.baseToken.symbol,
          usdc_in: this.cfg.positionSizeUsdc,
          tokens_out: fromRaw(tokensOutRaw, decimals),
          price: round(this.cfg.positionSizeUsdc / fromRaw(tokensOutRaw, decimals), 12),
          price_impact_pct: quote.priceImpactPct,
          tx: buyTx,
          dry_run: false,
        });
      }

      const tokensOutUi = fromRaw(tokensOutRaw, decimals);
      if (tokensOutUi <= 0) {
        logger.error('BUY_ZERO_TOKENS', { mint, tx: buyTx });
        return false;
      }

      const entryPrice = this.cfg.positionSizeUsdc / tokensOutUi;

      const position: Position = {
        mint,
        symbol: pair.baseToken.symbol ?? '?',
        name: pair.baseToken.name ?? '?',
        pairAddress: pair.pairAddress,
        decimals,
        entryTs: Date.now(),
        entryUsdc: this.cfg.positionSizeUsdc,
        entryTokensRaw: tokensOutRaw.toString(),
        remainingTokensRaw: tokensOutRaw.toString(),
        entryPriceUsdc: entryPrice,
        costBasisRemainingUsdc: this.cfg.positionSizeUsdc,
        peakPriceUsdc: entryPrice,
        trailingActive: false,
        partialSold: false,
        realizedUsdc: 0,
        buyTx,
        score: score.score,
        scoreBreakdown: score.breakdown,
        sellFailures: 0,
        lastPriceUsdc: entryPrice,
        lastPolledTs: Date.now(),
      };

      this.state.addPosition(position);
      return true;
    } catch (err) {
      logger.error('BUY_FAILED', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      this.inFlight.delete(mint);
    }
  }

  /**
   * Marks a position to market via a real sell quote for the exact size held.
   * A quote is the honest oracle here: DexScreener's priceUsd is a mid price and
   * ignores the impact of dumping this size into a thin pool.
   */
  async markToMarket(pos: Position): Promise<MarkResult> {
    const remainingRaw = BigInt(pos.remainingTokensRaw);
    if (remainingRaw <= 0n) return { ok: false, kind: 'empty' };

    const quoteRes = await this.jupiter.quote({
      inputMint: pos.mint,
      outputMint: USDC_MINT,
      amountRaw: remainingRaw,
      slippageBps: this.cfg.sellSlippageBps,
    });
    // Deliberately does not log — the caller knows how long the position has
    // been held and whether this is worth escalating. Logging here as well
    // produced two lines per failure saying different things.
    if (!quoteRes.ok) {
      return quoteRes.kind === 'fault'
        ? { ok: false, kind: 'fault', error: quoteRes.error, status: quoteRes.status }
        : { ok: false, kind: 'no_route' };
    }

    const valueUsdc = fromRaw(BigInt(quoteRes.quote.outAmount), USDC_DECIMALS);
    const tokensUi = fromRaw(remainingRaw, pos.decimals);
    if (tokensUi <= 0) return { ok: false, kind: 'empty' };

    return { ok: true, price: valueUsdc / tokensUi, valueUsdc };
  }

  /** One pass over every open position. Called on the price-poll interval. */
  async pollPositions(): Promise<void> {
    for (const pos of [...this.state.getPositions()]) {
      if (this.inFlight.has(pos.mint)) continue;
      try {
        await this.evaluate(pos);
      } catch (err) {
        logger.error('POLL_FAILED', {
          mint: pos.mint,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async evaluate(pos: Position): Promise<void> {
    const mark = await this.markToMarket(pos);
    const heldMinutes = (Date.now() - pos.entryTs) / 60_000;

    if (!mark.ok) {
      logger.warn('MARK_TO_MARKET_FAILED', {
        mint: pos.mint,
        symbol: pos.symbol,
        held_min: round(heldMinutes, 1),
        kind: mark.kind,
        ...(mark.kind === 'fault' ? { status: mark.status, error: mark.error } : {}),
        note:
          mark.kind === 'fault'
            ? 'Could not reach Jupiter. Says nothing about the pool — mark is stale, not gone.'
            : 'No Jupiter route for the held size — pool may be drained',
      });

      // Only chase the max-hold exit when the pool is genuinely unroutable. If
      // the fault is our own throttling, firing a sell adds three more requests
      // to a limiter that is already the reason we are here, and the retry storm
      // feeds itself. Wait for the next poll instead.
      if (mark.kind === 'no_route' && heldMinutes >= this.cfg.maxHoldMinutes) {
        await this.sell(pos, 100, 'MAX_HOLD');
      }
      return;
    }

    const { price, valueUsdc } = mark;
    const gainPct = (price / pos.entryPriceUsdc - 1) * 100;

    pos.lastPriceUsdc = price;
    pos.lastPolledTs = Date.now();
    if (price > pos.peakPriceUsdc) pos.peakPriceUsdc = price;

    if (!pos.trailingActive && gainPct >= this.cfg.trailingActivatePct) {
      pos.trailingActive = true;
      logger.info('TRAILING_STOP_ARMED', {
        mint: pos.mint,
        symbol: pos.symbol,
        gain_pct: round(gainPct, 2),
        peak_price: round(pos.peakPriceUsdc, 12),
      });
    }

    logger.debug('POSITION_MARK', {
      mint: pos.mint,
      symbol: pos.symbol,
      price: round(price, 12),
      value_usdc: round(valueUsdc, 4),
      gain_pct: round(gainPct, 2),
      held_min: round(heldMinutes, 1),
      trailing: pos.trailingActive,
    });

    this.state.save();

    // Exit checks, most urgent first.
    if (gainPct <= -this.cfg.stopLossPct) {
      await this.sell(pos, 100, 'STOP_LOSS');
      return;
    }

    if (pos.trailingActive) {
      const trailFloor = pos.peakPriceUsdc * (1 - this.cfg.trailingStopPct / 100);
      if (price <= trailFloor) {
        await this.sell(pos, 100, 'TRAILING_STOP');
        return;
      }
    }

    if (!pos.partialSold && gainPct >= this.cfg.takeProfitPct) {
      await this.sell(pos, this.cfg.partialSellPct, 'TAKE_PROFIT');
      return;
    }

    if (heldMinutes >= this.cfg.maxHoldMinutes) {
      await this.sell(pos, 100, 'MAX_HOLD');
    }
  }

  /**
   * Sells `pct` of what is still held. A partial sell keeps the position open
   * with a proportionally reduced cost basis; a 100% sell closes and books it.
   */
  async sell(pos: Position, pct: number, reason: ExitReason): Promise<boolean> {
    if (this.inFlight.has(pos.mint)) return false;
    this.inFlight.add(pos.mint);

    try {
      const remainingRaw = BigInt(pos.remainingTokensRaw);
      const fraction = Math.min(100, Math.max(1, pct)) / 100;
      let sellRaw =
        fraction >= 1
          ? remainingRaw
          : (remainingRaw * BigInt(Math.round(fraction * 10_000))) / 10_000n;
      if (sellRaw <= 0n) sellRaw = remainingRaw;

      const isFullExit = sellRaw >= remainingRaw;
      const costBasisSold = pos.costBasisRemainingUsdc * (isFullExit ? 1 : fraction);

      let usdcOut = 0;
      let signature: string | null = null;
      let lastError: string | null = null;
      let sold = false;

      for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt++) {
        const quoteRes = await this.jupiter.quote({
          inputMint: pos.mint,
          outputMint: USDC_MINT,
          amountRaw: sellRaw,
          slippageBps: this.cfg.sellSlippageBps,
        });

        if (!quoteRes.ok) {
          const throttled = quoteRes.kind === 'fault';
          lastError = throttled ? `quote fault: ${quoteRes.error}` : 'no route';
          logger.warn('SELL_FAILED', {
            mint: pos.mint,
            symbol: pos.symbol,
            attempt,
            reason,
            kind: quoteRes.kind,
            error: throttled ? quoteRes.error : 'no Jupiter route',
          });
          // A fault is not evidence about the pool, so retrying immediately just
          // spends the budget that would let the next attempt succeed. Space
          // them out; a genuine no_route can retry straight away.
          if (throttled && attempt < SELL_ATTEMPTS) {
            await sleep(2_000 * attempt);
          }
          continue;
        }
        const quote = quoteRes.quote;

        if (this.cfg.dryRun) {
          usdcOut = fromRaw(BigInt(quote.outAmount), USDC_DECIMALS);
          sold = true;
          break;
        }

        try {
          const result = await this.jupiter.swap(this.keypair, quote);
          signature = result.signature;
          usdcOut =
            result.outAmountRaw > 0n
              ? fromRaw(result.outAmountRaw, USDC_DECIMALS)
              : fromRaw(BigInt(quote.outAmount), USDC_DECIMALS);
          sold = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          logger.warn('SELL_FAILED', { mint: pos.mint, attempt, reason, error: lastError });
        }
      }

      if (!sold) {
        pos.sellFailures += 1;
        this.state.save();
        // Left open on purpose: the tokens are still in the wallet and the next
        // poll will try again. An unsold bag is a real, held risk, so it is loud.
        const throttled = lastError?.startsWith('quote fault:') ?? false;
        logger.error('SELL_ALERT', {
          mint: pos.mint,
          symbol: pos.symbol,
          reason,
          attempts: SELL_ATTEMPTS,
          cumulative_failures: pos.sellFailures,
          error: lastError,
          likely_cause: throttled ? 'client_throttled_or_upstream_down' : 'pool_unroutable',
          note: throttled
            ? 'Still exposed, but this is OUR request failing, not proof the pool is gone. ' +
              'Check JUPITER_MAX_REQ_PER_MIN and 429s before assuming a rug.'
            : 'Position still open and still exposed. Run `npm run sell-all` or exit manually.',
        });
        return false;
      }

      const pnlUsdc = usdcOut - costBasisSold;
      const pnlPct = costBasisSold > 0 ? (pnlUsdc / costBasisSold) * 100 : 0;
      const holdMinutes = (Date.now() - pos.entryTs) / 60_000;

      logger.info('SELL_EXECUTED', {
        mint: pos.mint,
        symbol: pos.symbol,
        reason,
        pct_sold: isFullExit ? 100 : Math.round(fraction * 100),
        usdc_out: round(usdcOut, 4),
        pnl_usdc: round(pnlUsdc, 4),
        pnl_pct: round(pnlPct, 2),
        hold_min: round(holdMinutes, 1),
        tx: signature,
        dry_run: this.cfg.dryRun,
      });

      pos.realizedUsdc += usdcOut;
      pos.sellFailures = 0;

      if (isFullExit) {
        const totalPnl = pos.realizedUsdc - pos.entryUsdc;
        const trade: ClosedTrade = {
          mint: pos.mint,
          symbol: pos.symbol,
          entryTs: pos.entryTs,
          exitTs: Date.now(),
          entryUsdc: pos.entryUsdc,
          exitUsdc: round(pos.realizedUsdc, 6),
          pnlUsdc: round(totalPnl, 6),
          pnlPct: round((totalPnl / pos.entryUsdc) * 100, 2),
          holdMinutes: round(holdMinutes, 2),
          reason,
          score: pos.score,
          buyTx: pos.buyTx,
          sellTxs: signature ? [signature] : [],
          dryRun: this.cfg.dryRun,
        };
        this.state.removePosition(pos.mint);
        this.state.recordClose(trade);

        logger.info('POSITION_CLOSED', {
          mint: pos.mint,
          symbol: pos.symbol,
          reason,
          pnl_usdc: trade.pnlUsdc,
          pnl_pct: trade.pnlPct,
          hold_min: trade.holdMinutes,
        });
      } else {
        pos.remainingTokensRaw = (remainingRaw - sellRaw).toString();
        pos.costBasisRemainingUsdc -= costBasisSold;
        pos.partialSold = true;
        // The rest rides on the trailing stop from here.
        pos.trailingActive = true;
        this.state.recordPartialRealized(pnlUsdc);

        logger.info('PARTIAL_SELL_COMPLETE', {
          mint: pos.mint,
          symbol: pos.symbol,
          remaining_tokens: fromRaw(BigInt(pos.remainingTokensRaw), pos.decimals),
          remaining_cost_basis_usdc: round(pos.costBasisRemainingUsdc, 4),
          note: 'Free-ride remainder now runs on the trailing stop only',
        });
      }

      return true;
    } finally {
      this.inFlight.delete(pos.mint);
    }
  }

  /** Emergency exit for every open position. Used by `npm run sell-all`. */
  async sellAll(reason: ExitReason = 'SELL_ALL'): Promise<{ sold: number; failed: number }> {
    let sold = 0;
    let failed = 0;
    for (const pos of [...this.state.getPositions()]) {
      const ok = await this.sell(pos, 100, reason);
      if (ok) sold++;
      else failed++;
    }
    return { sold, failed };
  }
}
