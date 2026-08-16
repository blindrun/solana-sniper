import type { Connection } from '@solana/web3.js';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { getMintInfo, rugCheck, type MintInfo, type RugCheckResult } from '../safety/rugcheck.js';
import { DexScreenerClient, type DexPair } from './dexscreener.js';

export interface ScoreBreakdown {
  liquidity: number;
  rugcheck: number;
  mintRevoked: number;
  freezeRevoked: number;
  buySellRatio: number;
  priceChange: number;
  socials: number;
  website: number;
  holders: number;
  volume: number;
}

export type DisqualifyReason =
  | 'blacklisted'
  | 'already_held'
  | 'no_pair'
  | 'unknown_age'
  | 'too_young'
  | 'too_old'
  | 'liquidity_below_minimum'
  | 'insufficient_transactions'
  | 'mint_info_unavailable'
  | 'mint_authority_not_revoked'
  | 'freeze_authority_not_revoked'
  | 'transfer_fee_token'
  | 'round_trip_loss_excessive'
  | 'rugcheck_unavailable'
  | 'rugcheck_high_risk'
  | 'top10_holders_concentrated'
  | 'score_below_minimum';

export interface ScoreResult {
  mint: string;
  score: number;
  breakdown: ScoreBreakdown;
  disqualified: boolean;
  reason: DisqualifyReason | null;
  pair: DexPair | null;
  mintInfo: MintInfo | null;
  rug: RugCheckResult | null;
  ageSeconds: number | null;
}

const ZERO_BREAKDOWN: ScoreBreakdown = {
  liquidity: 0,
  rugcheck: 0,
  mintRevoked: 0,
  freezeRevoked: 0,
  buySellRatio: 0,
  priceChange: 0,
  socials: 0,
  website: 0,
  holders: 0,
  volume: 0,
};

function disqualify(
  mint: string,
  reason: DisqualifyReason,
  extra: Partial<ScoreResult> = {},
): ScoreResult {
  return {
    mint,
    score: 0,
    breakdown: { ...ZERO_BREAKDOWN },
    disqualified: true,
    reason,
    pair: null,
    mintInfo: null,
    rug: null,
    ageSeconds: null,
    ...extra,
  };
}

export interface ScorerContext {
  cfg: Config;
  connection: Connection;
  dex: DexScreenerClient;
  /** Returns true if a position in this mint is already open. */
  holdsPosition: (mint: string) => boolean;
}

/**
 * NOTE ON TIME BUCKETS — DexScreener exposes m5/h1/h6/h24 only; there is no
 * 1-minute bucket on any public endpoint. The spec's "transactions in the first
 * minute" and "1m buy/sell ratio" are therefore both evaluated against the m5
 * bucket. For a token that is 45-120 seconds old the m5 bucket covers its entire
 * life, so the transaction count is the real lifetime count; the ratio is a
 * 5-minute average rather than a 1-minute one, which is slightly less reactive.
 */
export async function scoreToken(ctx: ScorerContext, mint: string): Promise<ScoreResult> {
  const { cfg } = ctx;

  // --- free checks, before any network call ---------------------------
  if (cfg.blacklistTokens.has(mint)) return disqualify(mint, 'blacklisted');
  if (ctx.holdsPosition(mint)) return disqualify(mint, 'already_held');

  // --- market data ----------------------------------------------------
  const pairs = await ctx.dex.pairsForToken(mint);
  const pair = DexScreenerClient.bestPair(pairs, mint);
  if (!pair) return disqualify(mint, 'no_pair');

  const createdAt = pair.pairCreatedAt;
  if (typeof createdAt !== 'number' || createdAt <= 0) {
    // Without an age we cannot know we are past the snipe wave, which is the
    // entire premise of the strategy. Refuse rather than guess.
    return disqualify(mint, 'unknown_age', { pair });
  }

  const ageSeconds = Math.floor((Date.now() - createdAt) / 1000);
  if (ageSeconds < cfg.minAgeSeconds) {
    return disqualify(mint, 'too_young', { pair, ageSeconds });
  }
  if (ageSeconds > cfg.maxAgeSeconds) {
    return disqualify(mint, 'too_old', { pair, ageSeconds });
  }

  const liquidityUsd = pair.liquidity?.usd ?? 0;
  if (liquidityUsd < cfg.minLiquidityUsd) {
    return disqualify(mint, 'liquidity_below_minimum', { pair, ageSeconds });
  }

  const m5 = pair.txns?.m5 ?? { buys: 0, sells: 0 };
  const txCount = (m5.buys ?? 0) + (m5.sells ?? 0);
  if (txCount < cfg.minTransactions) {
    return disqualify(mint, 'insufficient_transactions', { pair, ageSeconds });
  }

  // --- on-chain authorities -------------------------------------------
  const mintInfo = await getMintInfo(ctx.connection, mint);
  if (!mintInfo) {
    return disqualify(mint, 'mint_info_unavailable', { pair, ageSeconds });
  }
  if (!mintInfo.mintAuthorityRevoked) {
    return disqualify(mint, 'mint_authority_not_revoked', { pair, ageSeconds, mintInfo });
  }
  if (!mintInfo.freezeAuthorityRevoked) {
    return disqualify(mint, 'freeze_authority_not_revoked', { pair, ageSeconds, mintInfo });
  }

  // Token-2022 transfer fee. This is the honeypot that passes every other check:
  // the mint is fully revoked, RugCheck rates it low, liquidity is real, and the
  // token still taxes most of the value out of your sell. Observed live at
  // 8100 bps on a token that cleared every other filter in this function.
  if (mintInfo.transferFeeBps !== null && mintInfo.transferFeeBps > cfg.maxTransferFeeBps) {
    logger.warn('TRANSFER_FEE_TOKEN_REJECTED', {
      mint,
      token_program: mintInfo.tokenProgram,
      transfer_fee_bps: mintInfo.transferFeeBps,
      limit_bps: cfg.maxTransferFeeBps,
    });
    return disqualify(mint, 'transfer_fee_token', { pair, ageSeconds, mintInfo });
  }

  // --- third-party rug assessment -------------------------------------
  const rug = await rugCheck(mint);
  if (!rug.available && cfg.requireRugcheck) {
    return disqualify(mint, 'rugcheck_unavailable', { pair, ageSeconds, mintInfo, rug });
  }
  if (rug.risk === 'high' || rug.risk === 'very_high') {
    return disqualify(mint, 'rugcheck_high_risk', { pair, ageSeconds, mintInfo, rug });
  }
  if (rug.top10HolderPct !== null && rug.top10HolderPct > cfg.maxTop10HolderPct) {
    return disqualify(mint, 'top10_holders_concentrated', { pair, ageSeconds, mintInfo, rug });
  }

  // --- scoring ---------------------------------------------------------
  const breakdown: ScoreBreakdown = { ...ZERO_BREAKDOWN };

  if (liquidityUsd >= 50_000) breakdown.liquidity = 30;
  else if (liquidityUsd >= 10_000) breakdown.liquidity = 20;
  else if (liquidityUsd >= 5_000) breakdown.liquidity = 10;

  if (rug.risk === 'low') breakdown.rugcheck = 25;
  else if (rug.risk === 'medium') breakdown.rugcheck = 10;

  breakdown.mintRevoked = 20;
  breakdown.freezeRevoked = 10;

  // Sustained buy pressure after the launch spike is the "second wave" signal.
  const buys = m5.buys ?? 0;
  const sells = m5.sells ?? 0;
  const ratio = sells > 0 ? buys / sells : buys > 0 ? Number.POSITIVE_INFINITY : 0;
  if (ratio > 1.5) breakdown.buySellRatio = 15;

  const priceChangeM5 = pair.priceChange?.m5 ?? 0;
  if (priceChangeM5 > 5) breakdown.priceChange = 10;

  const socials = pair.info?.socials ?? [];
  const hasSocial = socials.some((s) => {
    const kind = (s.type ?? s.platform ?? '').toLowerCase();
    const url = (s.url ?? '').toLowerCase();
    return (
      kind.includes('twitter') ||
      kind.includes('telegram') ||
      kind.includes('x') ||
      url.includes('twitter.com') ||
      url.includes('x.com') ||
      url.includes('t.me')
    );
  });
  if (hasSocial) breakdown.socials = 5;

  if ((pair.info?.websites ?? []).length > 0) breakdown.website = 5;

  if (rug.holderCount !== null && rug.holderCount > 100) breakdown.holders = 10;

  const volumeM5 = pair.volume?.m5 ?? 0;
  if (volumeM5 > 10_000) breakdown.volume = 15;

  const rawScore = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, rawScore);

  const result: ScoreResult = {
    mint,
    score,
    breakdown,
    disqualified: score < cfg.minSafetyScore,
    reason: score < cfg.minSafetyScore ? 'score_below_minimum' : null,
    pair,
    mintInfo,
    rug,
    ageSeconds,
  };

  logger.debug('SCORE_DETAIL', {
    mint,
    score,
    liquidity_usd: Math.round(liquidityUsd),
    tx_m5: txCount,
    buy_sell_ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : 'inf',
    price_change_m5: priceChangeM5,
    volume_m5: Math.round(volumeM5),
    rug_risk: rug.risk,
    holders: rug.holderCount,
    top10_pct: rug.top10HolderPct,
  });

  return result;
}
