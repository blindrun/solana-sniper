import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Well-known mints. USDC is the base currency for every position. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_DECIMALS = 6;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface Config {
  // Wallet / RPC
  walletPrivateKey: string | null;
  solanaRpcUrl: string;
  jupiterBaseUrl: string;
  jupiterApiKey: string | null;
  jupiterMaxReqPerMin: number;

  // Strategy
  positionSizeUsdc: number;
  maxPositions: number;
  minSafetyScore: number;
  minAgeSeconds: number;
  maxAgeSeconds: number;
  minLiquidityUsd: number;
  minTransactions: number;
  maxTop10HolderPct: number;
  maxTransferFeeBps: number;
  maxRoundTripLossPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  trailingActivatePct: number;
  partialSellPct: number;
  maxHoldMinutes: number;

  // Fees
  priorityFeeLamports: number;
  slippageBps: number;
  sellSlippageBps: number;

  // Operations
  dryRun: boolean;
  discoveryIntervalMs: number;
  candidateIntervalMs: number;
  pricePollIntervalMs: number;
  logLevel: LogLevel;
  enableWebsocket: boolean;

  // Filters
  chain: string;
  blacklistTokens: Set<string>;
  requireRugcheck: boolean;

  // Hard safety rails
  maxDailySpendUsdc: number;
  maxDailyLossUsdc: number;
  minSolBalance: number;

  // Paths
  rootDir: string;
  dataDir: string;
  logDir: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/ (or src/ under tsx) lives one level under the project root. */
const ROOT = path.resolve(HERE, '..');

function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function num(name: string, def: number): number {
  const v = raw(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Config error: ${name}="${v}" is not a number`);
  }
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = raw(name);
  if (v === undefined) return def;
  const l = v.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(l)) return true;
  if (['false', '0', 'no', 'off'].includes(l)) return false;
  throw new Error(`Config error: ${name}="${v}" is not a boolean`);
}

function str(name: string, def: string): string {
  return raw(name) ?? def;
}

function list(name: string): string[] {
  const v = raw(name);
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Config error: ${msg}`);
}

export function loadConfig(): Config {
  const logLevelRaw = str('LOG_LEVEL', 'INFO').toUpperCase();
  assert(
    ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevelRaw),
    `LOG_LEVEL must be one of DEBUG|INFO|WARN|ERROR, got "${logLevelRaw}"`,
  );

  const positionSizeUsdc = num('POSITION_SIZE_USDC', 25);
  const maxPositions = num('MAX_POSITIONS', 5);

  const cfg: Config = {
    walletPrivateKey: raw('WALLET_PRIVATE_KEY') ?? null,
    solanaRpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    // The v6 host in the original spec (quote-api.jup.ag) no longer resolves.
    // lite-api is the current keyless tier; api.jup.ag needs JUPITER_API_KEY.
    jupiterBaseUrl: str('JUPITER_BASE_URL', 'https://lite-api.jup.ag/swap/v1'),
    jupiterApiKey: raw('JUPITER_API_KEY') ?? null,
    jupiterMaxReqPerMin: num('JUPITER_MAX_REQ_PER_MIN', 30),

    positionSizeUsdc,
    maxPositions,
    minSafetyScore: num('MIN_SAFETY_SCORE', 60),
    minAgeSeconds: num('MIN_AGE_SECONDS', 45),
    maxAgeSeconds: num('MAX_AGE_SECONDS', 1800),
    minLiquidityUsd: num('MIN_LIQUIDITY_USD', 5000),
    minTransactions: num('MIN_TRANSACTIONS', 50),
    maxTop10HolderPct: num('MAX_TOP10_HOLDER_PCT', 80),
    maxTransferFeeBps: num('MAX_TRANSFER_FEE_BPS', 100),
    maxRoundTripLossPct: num('MAX_ROUND_TRIP_LOSS_PCT', 15),
    takeProfitPct: num('TAKE_PROFIT_PCT', 150),
    stopLossPct: num('STOP_LOSS_PCT', 40),
    trailingStopPct: num('TRAILING_STOP_PCT', 25),
    trailingActivatePct: num('TRAILING_ACTIVATE_PCT', 50),
    partialSellPct: num('PARTIAL_SELL_PCT', 75),
    maxHoldMinutes: num('MAX_HOLD_MINUTES', 60),

    priorityFeeLamports: num('PRIORITY_FEE_LAMPORTS', 100_000),
    slippageBps: num('SLIPPAGE_BPS', 300),
    sellSlippageBps: num('SELL_SLIPPAGE_BPS', 500),

    dryRun: bool('DRY_RUN', true),
    discoveryIntervalMs: num('DISCOVERY_INTERVAL_MS', 10_000),
    candidateIntervalMs: num('CANDIDATE_INTERVAL_MS', 5_000),
    pricePollIntervalMs: num('PRICE_POLL_INTERVAL_MS', 20_000),
    logLevel: logLevelRaw as LogLevel,
    // Off by default: DexScreener's realtime endpoint is undocumented and
    // currently 404s from every path it used to serve. REST polling is the
    // supported discovery route; this is left switchable in case it returns.
    enableWebsocket: bool('ENABLE_WEBSOCKET', false),

    chain: str('CHAIN', 'solana'),
    blacklistTokens: new Set(list('BLACKLIST_TOKENS')),
    requireRugcheck: bool('REQUIRE_RUGCHECK', true),

    maxDailySpendUsdc: num('MAX_DAILY_SPEND_USDC', maxPositions * positionSizeUsdc * 3),
    maxDailyLossUsdc: num('MAX_DAILY_LOSS_USDC', 100),
    minSolBalance: num('MIN_SOL_BALANCE', 0.05),

    rootDir: ROOT,
    dataDir: path.join(ROOT, 'data'),
    logDir: path.join(ROOT, 'logs'),
  };

  // --- validation ------------------------------------------------------
  assert(cfg.positionSizeUsdc > 0, 'POSITION_SIZE_USDC must be > 0');
  assert(cfg.maxPositions >= 1, 'MAX_POSITIONS must be >= 1');
  assert(
    cfg.minSafetyScore >= 0 && cfg.minSafetyScore <= 100,
    'MIN_SAFETY_SCORE must be between 0 and 100',
  );
  assert(cfg.minAgeSeconds >= 0, 'MIN_AGE_SECONDS must be >= 0');
  assert(
    cfg.maxAgeSeconds > cfg.minAgeSeconds,
    'MAX_AGE_SECONDS must be greater than MIN_AGE_SECONDS',
  );
  assert(cfg.minLiquidityUsd >= 0, 'MIN_LIQUIDITY_USD must be >= 0');
  assert(
    cfg.maxTransferFeeBps >= 0 && cfg.maxTransferFeeBps <= 10_000,
    'MAX_TRANSFER_FEE_BPS must be between 0 and 10000',
  );
  assert(
    cfg.maxRoundTripLossPct > 0 && cfg.maxRoundTripLossPct < 100,
    'MAX_ROUND_TRIP_LOSS_PCT must be between 0 and 100 (exclusive)',
  );
  assert(cfg.takeProfitPct > 0, 'TAKE_PROFIT_PCT must be > 0');
  assert(
    cfg.stopLossPct > 0 && cfg.stopLossPct < 100,
    'STOP_LOSS_PCT must be between 0 and 100 (exclusive)',
  );
  assert(
    cfg.trailingStopPct > 0 && cfg.trailingStopPct < 100,
    'TRAILING_STOP_PCT must be between 0 and 100 (exclusive)',
  );
  assert(
    cfg.partialSellPct > 0 && cfg.partialSellPct <= 100,
    'PARTIAL_SELL_PCT must be between 0 and 100',
  );
  assert(cfg.maxHoldMinutes > 0, 'MAX_HOLD_MINUTES must be > 0');
  assert(
    cfg.slippageBps > 0 && cfg.slippageBps <= 10_000,
    'SLIPPAGE_BPS must be between 1 and 10000',
  );
  assert(
    cfg.sellSlippageBps > 0 && cfg.sellSlippageBps <= 10_000,
    'SELL_SLIPPAGE_BPS must be between 1 and 10000',
  );
  assert(cfg.priorityFeeLamports >= 0, 'PRIORITY_FEE_LAMPORTS must be >= 0');
  assert(cfg.discoveryIntervalMs >= 1000, 'DISCOVERY_INTERVAL_MS must be >= 1000');
  assert(cfg.candidateIntervalMs >= 1000, 'CANDIDATE_INTERVAL_MS must be >= 1000');
  assert(cfg.pricePollIntervalMs >= 1000, 'PRICE_POLL_INTERVAL_MS must be >= 1000');
  assert(cfg.jupiterMaxReqPerMin > 0, 'JUPITER_MAX_REQ_PER_MIN must be > 0');

  // Mark-to-market alone costs one quote per open position per poll. If that
  // exceeds the whole Jupiter budget there is nothing left for discovery, the
  // pre-buy round-trip check, or the sells themselves — which is precisely the
  // state that produced 2,316 × 429 and three unsellable positions on
  // 2026-08-15. Refuse to start rather than discover it an hour in.
  const markToMarketPerMin =
    cfg.maxPositions * (60_000 / cfg.pricePollIntervalMs);
  assert(
    markToMarketPerMin <= cfg.jupiterMaxReqPerMin * 0.6,
    `MAX_POSITIONS=${cfg.maxPositions} at PRICE_POLL_INTERVAL_MS=${cfg.pricePollIntervalMs} needs ` +
      `${Math.ceil(markToMarketPerMin)} Jupiter req/min for mark-to-market alone, more than half the ` +
      `JUPITER_MAX_REQ_PER_MIN=${cfg.jupiterMaxReqPerMin} budget. Raise the interval, lower ` +
      `MAX_POSITIONS, or raise the budget (needs a JUPITER_API_KEY).`,
  );
  assert(cfg.chain === 'solana', 'CHAIN must be "solana" — no other chain is implemented');
  assert(cfg.maxDailySpendUsdc > 0, 'MAX_DAILY_SPEND_USDC must be > 0');
  assert(cfg.maxDailyLossUsdc > 0, 'MAX_DAILY_LOSS_USDC must be > 0');

  if (!cfg.dryRun && !cfg.walletPrivateKey) {
    throw new Error(
      'Config error: WALLET_PRIVATE_KEY is required when DRY_RUN=false. ' +
        'Generate one with: solana-keygen new --outfile ~/sniper-wallet.json',
    );
  }

  return cfg;
}

/** Redacted view of the config, safe to log at startup. */
export function redactedConfig(cfg: Config): Record<string, unknown> {
  const { walletPrivateKey, solanaRpcUrl, jupiterApiKey, blacklistTokens, ...rest } = cfg;
  return {
    ...rest,
    walletPrivateKey: walletPrivateKey ? '[REDACTED]' : null,
    jupiterApiKey: jupiterApiKey ? '[REDACTED]' : null,
    // The Helius/Triton API key rides in the URL query string — strip it.
    solanaRpcUrl: solanaRpcUrl.replace(/([?&](api-key|api_key|key)=)[^&]+/gi, '$1[REDACTED]'),
    blacklistTokens: [...blacklistTokens],
  };
}
