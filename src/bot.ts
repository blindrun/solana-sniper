import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, redactedConfig, type Config } from './config.js';
import { closeLogger, configureLogger, logger } from './logger.js';
import { sleep } from './http.js';
import {
  DexScreenerClient,
  DexScreenerWebSocket,
  type DexPair,
} from './discovery/dexscreener.js';
import { scoreToken, type DisqualifyReason, type ScorerContext } from './discovery/scorer.js';
import { JupiterClient } from './trading/jupiter.js';
import { PositionManager } from './trading/position_manager.js';
import { StateManager, round } from './state/state_manager.js';
import { Wallet } from './wallet/wallet.js';

/**
 * A disqualification that can plausibly resolve on its own. `too_young` is the
 * important one — the whole second-wave premise is finding a token early and
 * then deliberately waiting, so a token seen at 10 seconds old must be kept and
 * re-scored at 45, not discarded.
 */
const RETRYABLE: ReadonlySet<DisqualifyReason> = new Set<DisqualifyReason>([
  'no_pair',
  'unknown_age',
  'too_young',
  'liquidity_below_minimum',
  'insufficient_transactions',
  'mint_info_unavailable',
  'rugcheck_unavailable',
  'score_below_minimum',
]);

const MAX_QUEUE = 500;
const MAX_ATTEMPTS = 40;

interface Candidate {
  mint: string;
  firstSeenTs: number;
  nextEligibleTs: number;
  attempts: number;
  source: 'profiles' | 'boosts' | 'websocket';
}

class Bot {
  private readonly cfg: Config;
  private readonly state: StateManager;
  private readonly dex: DexScreenerClient;
  private readonly wallet: Wallet;
  private readonly jupiter: JupiterClient;
  private readonly positions: PositionManager;
  private readonly ws: DexScreenerWebSocket;
  private readonly scorerCtx: ScorerContext;

  private readonly queue = new Map<string, Candidate>();
  private running = false;
  private shuttingDown = false;
  private readonly pidFile: string;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.state = new StateManager(cfg.dataDir);
    this.dex = new DexScreenerClient(cfg);
    this.wallet = Wallet.load(cfg);
    this.jupiter = new JupiterClient(cfg, this.wallet.connection);
    this.positions = new PositionManager(
      cfg,
      this.state,
      this.jupiter,
      this.wallet,
      this.wallet.keypair,
    );
    this.scorerCtx = {
      cfg,
      connection: this.wallet.connection,
      dex: this.dex,
      holdsPosition: (mint) => this.state.holdsPosition(mint),
    };
    this.ws = new DexScreenerWebSocket(cfg, (mint, pair) => this.onWebsocketToken(mint, pair));
    this.pidFile = path.join(cfg.dataDir, 'bot.pid');
  }

  async start(): Promise<void> {
    this.state.load();
    this.running = true;
    fs.writeFileSync(this.pidFile, String(process.pid));

    logger.info('BOT_STARTED', {
      pid: process.pid,
      dry_run: this.cfg.dryRun,
      wallet: this.wallet.publicKey.toBase58(),
      open_positions: this.state.getPositions().length,
      seen_tokens: this.state.seenCount(),
      config: redactedConfig(this.cfg),
    });

    if (this.cfg.dryRun) {
      logger.warn('DRY_RUN_ACTIVE', {
        note: 'No transaction will be submitted. Every buy and sell below is simulated against real Jupiter quotes.',
      });
    } else {
      logger.warn('LIVE_TRADING_ACTIVE', {
        note: 'DRY_RUN=false. Real funds will be spent.',
        position_size_usdc: this.cfg.positionSizeUsdc,
        max_daily_spend_usdc: this.cfg.maxDailySpendUsdc,
      });
    }

    await this.reportBalances();

    this.ws.start();

    // Three independent loops. Each catches its own errors so one failing feed
    // cannot take down position management, which is the part holding money.
    void this.loop('discovery', this.cfg.discoveryIntervalMs, () => this.runDiscovery());
    void this.loop('candidates', this.cfg.candidateIntervalMs, () => this.runCandidates());
    void this.loop('prices', this.cfg.pricePollIntervalMs, () => this.positions.pollPositions());
  }

  private async reportBalances(): Promise<void> {
    try {
      const [usdc, sol] = await Promise.all([
        this.wallet.usdcBalance(),
        this.wallet.solBalance(),
      ]);
      logger.info('WALLET_BALANCE', {
        usdc: round(usdc, 4),
        sol: round(sol, 6),
        sufficient_for_buy: usdc >= this.cfg.positionSizeUsdc * 1.1,
        sufficient_sol_for_fees: sol >= this.cfg.minSolBalance,
      });
    } catch (err) {
      logger.warn('BALANCE_CHECK_FAILED', {
        error: err instanceof Error ? err.message : String(err),
        note: 'Check SOLANA_RPC_URL. The public RPC rate-limits this call hard.',
      });
    }
  }

  private async loop(name: string, intervalMs: number, fn: () => Promise<void>): Promise<void> {
    while (this.running) {
      const started = Date.now();
      try {
        await fn();
      } catch (err) {
        logger.error('LOOP_ERROR', {
          loop: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const elapsed = Date.now() - started;
      await sleep(Math.max(250, intervalMs - elapsed));
    }
  }

  // --- discovery -------------------------------------------------------

  private enqueue(mint: string, source: Candidate['source']): void {
    if (this.queue.has(mint)) return;
    if (this.state.hasSeen(mint)) return;
    if (this.state.holdsPosition(mint)) return;
    if (this.cfg.blacklistTokens.has(mint)) return;

    if (this.queue.size >= MAX_QUEUE) {
      // Drop the oldest rather than the newest: an old candidate has already had
      // its chance to mature and a fresh one is the whole point of the strategy.
      const oldest = [...this.queue.values()].sort((a, b) => a.firstSeenTs - b.firstSeenTs)[0];
      if (oldest) this.queue.delete(oldest.mint);
    }

    this.queue.set(mint, {
      mint,
      firstSeenTs: Date.now(),
      nextEligibleTs: Date.now(),
      attempts: 0,
      source,
    });

    logger.info('TOKEN_DISCOVERED', {
      mint,
      source,
      queue_depth: this.queue.size,
      action: 'queued',
    });
  }

  private onWebsocketToken(mint: string, pair: DexPair): void {
    // The websocket carries the full h24 screener, most of which is old. Only
    // pairs young enough to still be in scope are worth queueing.
    const createdAt = pair.pairCreatedAt;
    if (typeof createdAt === 'number' && createdAt > 0) {
      const ageSeconds = (Date.now() - createdAt) / 1000;
      if (ageSeconds > this.cfg.maxAgeSeconds) return;
    } else {
      return;
    }
    this.enqueue(mint, 'websocket');
  }

  private async runDiscovery(): Promise<void> {
    const [profiles, boosts] = await Promise.allSettled([
      this.dex.latestTokenProfiles(),
      this.dex.latestBoosts(),
    ]);

    if (profiles.status === 'fulfilled') {
      for (const p of profiles.value) this.enqueue(p.tokenAddress, 'profiles');
    } else {
      logger.warn('DISCOVERY_PROFILES_FAILED', { error: String(profiles.reason) });
    }

    if (boosts.status === 'fulfilled') {
      for (const b of boosts.value) this.enqueue(b.tokenAddress, 'boosts');
    } else {
      logger.warn('DISCOVERY_BOOSTS_FAILED', { error: String(boosts.reason) });
    }
  }

  // --- candidate processing -------------------------------------------

  private async runCandidates(): Promise<void> {
    const now = Date.now();
    const due = [...this.queue.values()]
      .filter((c) => c.nextEligibleTs <= now)
      .sort((a, b) => a.firstSeenTs - b.firstSeenTs);

    if (due.length === 0) return;

    const blocked = await this.positions.checkBuyAllowed();
    if (blocked) {
      logger.debug('BUY_BLOCKED', { reason: blocked.reason, ...blocked.detail });
      // Still drain the queue of anything that has aged out, so it does not grow
      // unbounded while buying is paused.
      this.expireStale();
      return;
    }

    // One candidate per tick keeps the API budget predictable — each score costs
    // one DexScreener call, one RPC call and one RugCheck call.
    const candidate = due[0];
    if (!candidate) return;

    candidate.attempts += 1;

    let result;
    try {
      result = await scoreToken(this.scorerCtx, candidate.mint);
    } catch (err) {
      logger.warn('SCORE_ERROR', {
        mint: candidate.mint,
        error: err instanceof Error ? err.message : String(err),
      });
      candidate.nextEligibleTs = Date.now() + 15_000;
      if (candidate.attempts >= MAX_ATTEMPTS) this.drop(candidate.mint, 'score_errors');
      return;
    }

    if (result.disqualified) {
      const reason = result.reason ?? 'score_below_minimum';

      logger.info('TOKEN_SKIPPED', {
        mint: candidate.mint,
        score: result.score,
        reason,
        age_sec: result.ageSeconds,
        liquidity_usd: result.pair?.liquidity?.usd
          ? Math.round(result.pair.liquidity.usd)
          : null,
        attempt: candidate.attempts,
        retryable: RETRYABLE.has(reason),
      });

      if (!RETRYABLE.has(reason) || candidate.attempts >= MAX_ATTEMPTS) {
        this.drop(candidate.mint, reason);
        return;
      }

      // For a too-young token, wait exactly until it crosses MIN_AGE_SECONDS
      // rather than burning API budget on a fixed poll.
      if (reason === 'too_young' && result.ageSeconds !== null) {
        const waitMs = (this.cfg.minAgeSeconds - result.ageSeconds) * 1000 + 1_000;
        candidate.nextEligibleTs = Date.now() + Math.max(2_000, waitMs);
      } else {
        candidate.nextEligibleTs = Date.now() + 20_000;
      }
      return;
    }

    logger.info('SCORE_RESULT', {
      mint: candidate.mint,
      symbol: result.pair?.baseToken.symbol ?? null,
      score: result.score,
      breakdown: result.breakdown,
      age_sec: result.ageSeconds,
      liquidity_usd: result.pair?.liquidity?.usd ? Math.round(result.pair.liquidity.usd) : null,
      rug_risk: result.rug?.risk ?? null,
      action: 'BUY',
    });

    // Passing tokens are marked seen either way, so a failed buy is not retried
    // in a loop against a market that has already moved.
    this.drop(candidate.mint, 'bought_or_attempted');
    await this.positions.buy(result);
  }

  private drop(mint: string, _reason: string): void {
    this.queue.delete(mint);
    this.state.markSeen(mint);
    this.state.saveSeen();
  }

  private expireStale(): void {
    const cutoff = Date.now() - this.cfg.maxAgeSeconds * 1000;
    for (const c of [...this.queue.values()]) {
      if (c.firstSeenTs < cutoff) this.drop(c.mint, 'aged_out');
    }
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;

    logger.info('BOT_STOPPING', {
      signal,
      open_positions: this.state.getPositions().length,
      note: 'Open positions are persisted and resume on next start. They are NOT sold on shutdown — use `npm run sell-all` for that.',
    });

    this.ws.stop();
    this.state.saveAll();

    try {
      fs.unlinkSync(this.pidFile);
    } catch {
      // Already gone; nothing to do.
    }

    closeLogger();
  }
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  configureLogger(cfg.logLevel, cfg.logDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const bot = new Bot(cfg);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void bot.shutdown(signal).then(() => process.exit(0));
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED_REJECTION', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT_EXCEPTION', { error: err.message, stack: err.stack });
    void bot.shutdown('uncaughtException').then(() => process.exit(1));
  });

  await bot.start();
}

void main();
