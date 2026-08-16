import { Connection, PublicKey } from '@solana/web3.js';
import { httpJson, RateLimiter } from '../http.js';
import { logger } from '../logger.js';

const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1';
/** No published number; held deliberately low so the free endpoint keeps answering. */
const LIMITER = new RateLimiter(60, 1, 'rugcheck');

export type RiskLevel = 'low' | 'medium' | 'high' | 'very_high' | 'unknown';

export interface MintInfo {
  decimals: number;
  supplyRaw: bigint;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Owning program: the classic SPL Token program, or Token-2022. */
  tokenProgram: string;
  /**
   * Token-2022 transfer fee in basis points, or null when the mint has no
   * transfer-fee extension. A high value here is a legal honeypot: the token
   * buys normally and then taxes most of the value out of the sell.
   */
  transferFeeBps: number | null;
  /** Absolute per-transfer fee cap in base units, if the extension sets one. */
  transferFeeMaxRaw: bigint | null;
}

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface RugCheckResult {
  risk: RiskLevel;
  /** RugCheck's normalised 0-100 risk score where available (higher = riskier). */
  riskScore: number | null;
  holderCount: number | null;
  /** Percent of supply held by the top 10 non-LP holders. */
  top10HolderPct: number | null;
  flags: string[];
  /** True when the API answered; false when it errored, timed out or 404'd. */
  available: boolean;
}

interface RugCheckReport {
  score?: number;
  score_normalised?: number;
  totalHolders?: number;
  risks?: { name?: string; level?: string; description?: string; score?: number }[];
  topHolders?: {
    address?: string;
    owner?: string;
    pct?: number;
    insider?: boolean;
    amount?: number;
  }[];
  markets?: {
    liquidityA?: string;
    liquidityB?: string;
    lp?: { lpLockedPct?: number; lpLocked?: number };
  }[];
  token?: { decimals?: number; supply?: number; mintAuthority?: string | null; freezeAuthority?: string | null };
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

/**
 * On-chain authority check, read straight from the mint account. This is the
 * only authoritative source — RugCheck also reports it, but a third-party cache
 * is not something to trust with the "can this dev print infinite supply"
 * question, so the RPC answer wins.
 */
export async function getMintInfo(
  connection: Connection,
  mint: string,
): Promise<MintInfo | null> {
  try {
    const res = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const value = res.value;
    if (!value || !('parsed' in value.data)) return null;

    const parsed = value.data.parsed as {
      type?: string;
      info?: {
        decimals?: number;
        supply?: string;
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        extensions?: {
          extension?: string;
          state?: {
            newerTransferFee?: { transferFeeBasisPoints?: number; maximumFee?: number | string };
            olderTransferFee?: { transferFeeBasisPoints?: number; maximumFee?: number | string };
          };
        }[];
      };
    };
    if (parsed.type !== 'mint' || !parsed.info) return null;

    const info = parsed.info;

    // Token-2022 transfer fee, when present. The "newer" fee is the one that
    // applies from the current epoch onward, so it is the one that matters.
    let transferFeeBps: number | null = null;
    let transferFeeMaxRaw: bigint | null = null;
    const feeExt = (info.extensions ?? []).find((e) => e.extension === 'transferFeeConfig');
    if (feeExt) {
      const fee = feeExt.state?.newerTransferFee ?? feeExt.state?.olderTransferFee;
      transferFeeBps = typeof fee?.transferFeeBasisPoints === 'number'
        ? fee.transferFeeBasisPoints
        : 0;
      if (fee?.maximumFee !== undefined) {
        try {
          transferFeeMaxRaw = BigInt(fee.maximumFee);
        } catch {
          transferFeeMaxRaw = null;
        }
      }
    }

    return {
      decimals: info.decimals ?? 0,
      supplyRaw: BigInt(info.supply ?? '0'),
      // The parsed RPC form omits the field entirely once the authority is burned.
      mintAuthorityRevoked: info.mintAuthority == null,
      freezeAuthorityRevoked: info.freezeAuthority == null,
      tokenProgram: value.owner.toBase58(),
      transferFeeBps,
      transferFeeMaxRaw,
    };
  } catch (err) {
    logger.warn('MINT_INFO_FAILED', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function deriveRisk(report: RugCheckReport): { level: RiskLevel; score: number | null } {
  const risks = report.risks ?? [];
  const levels = risks.map((r) => (r.level ?? '').toLowerCase());

  // An explicit danger flag outranks any aggregate score.
  if (levels.includes('danger')) {
    return { level: 'high', score: report.score_normalised ?? report.score ?? null };
  }

  const normalised = report.score_normalised;
  if (typeof normalised === 'number') {
    if (normalised >= 70) return { level: 'very_high', score: normalised };
    if (normalised >= 45) return { level: 'high', score: normalised };
    if (normalised >= 20) return { level: 'medium', score: normalised };
    return { level: 'low', score: normalised };
  }

  if (levels.includes('warn')) return { level: 'medium', score: report.score ?? null };
  if (risks.length > 0) return { level: 'medium', score: report.score ?? null };
  if (typeof report.score === 'number') {
    return { level: report.score > 2000 ? 'high' : 'low', score: null };
  }
  return { level: 'unknown', score: null };
}

/**
 * Top-10 concentration, with the pool's own liquidity accounts excluded. A
 * locked LP account routinely shows up as the largest holder; counting it would
 * disqualify healthy tokens for the exact structure that makes them tradable.
 */
function top10Pct(report: RugCheckReport): number | null {
  const holders = report.topHolders;
  if (!Array.isArray(holders) || holders.length === 0) return null;

  const lpAccounts = new Set<string>();
  for (const m of report.markets ?? []) {
    if (m.liquidityA) lpAccounts.add(m.liquidityA);
    if (m.liquidityB) lpAccounts.add(m.liquidityB);
  }

  const relevant = holders.filter(
    (h) => !(h.address && lpAccounts.has(h.address)) && !(h.owner && lpAccounts.has(h.owner)),
  );

  const sum = relevant
    .slice(0, 10)
    .reduce((acc, h) => acc + (typeof h.pct === 'number' ? h.pct : 0), 0);

  return Number.isFinite(sum) ? sum : null;
}

export async function rugCheck(mint: string): Promise<RugCheckResult> {
  const unavailable: RugCheckResult = {
    risk: 'unknown',
    riskScore: null,
    holderCount: null,
    top10HolderPct: null,
    flags: [],
    available: false,
  };

  try {
    const report = await httpJson<RugCheckReport>(
      `${RUGCHECK_BASE}/tokens/${mint}/report`,
      { label: 'rugcheck.report', limiter: LIMITER, retries: 2, timeoutMs: 10_000 },
    );

    const { level, score } = deriveRisk(report);
    return {
      risk: level,
      riskScore: score,
      holderCount: typeof report.totalHolders === 'number' ? report.totalHolders : null,
      top10HolderPct: top10Pct(report),
      flags: (report.risks ?? [])
        .map((r) => r.name)
        .filter((n): n is string => typeof n === 'string'),
      available: true,
    };
  } catch (err) {
    logger.warn('RUGCHECK_FAILED', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
    return unavailable;
  }
}
