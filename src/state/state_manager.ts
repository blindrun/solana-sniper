import fs from 'node:fs';
import path from 'node:path';
import type { ScoreBreakdown } from '../discovery/scorer.js';
import { logger } from '../logger.js';

export type ExitReason =
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'MAX_HOLD'
  | 'MANUAL'
  | 'SELL_ALL';

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  decimals: number;

  entryTs: number;
  /** USDC actually spent on the buy. */
  entryUsdc: number;
  /** Raw token base units received on the buy. */
  entryTokensRaw: string;
  /** Raw token base units still held (drops after a partial take-profit sell). */
  remainingTokensRaw: string;
  /** USDC price per whole token at entry. */
  entryPriceUsdc: number;
  /** Cost basis attributable to the tokens still held. */
  costBasisRemainingUsdc: number;

  /**
   * Highest USDC price per token seen since entry, for the trailing stop.
   * Price rather than position value, so a partial take-profit sell does not
   * reset the trail on whatever is still held.
   */
  peakPriceUsdc: number;
  trailingActive: boolean;
  partialSold: boolean;
  /** USDC realized so far from partial sells on this position. */
  realizedUsdc: number;

  buyTx: string | null;
  score: number;
  scoreBreakdown: ScoreBreakdown;

  /** Consecutive failed sell attempts; used to escalate to an alert. */
  sellFailures: number;
  lastPriceUsdc: number | null;
  lastPolledTs: number | null;
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  entryTs: number;
  exitTs: number;
  entryUsdc: number;
  exitUsdc: number;
  pnlUsdc: number;
  pnlPct: number;
  holdMinutes: number;
  reason: ExitReason;
  score: number;
  buyTx: string | null;
  sellTxs: string[];
  dryRun: boolean;
}

export interface DailyStats {
  date: string;
  spentUsdc: number;
  realizedPnlUsdc: number;
  buys: number;
  sells: number;
}

export interface BotState {
  version: 1;
  positions: Position[];
  closed: ClosedTrade[];
  daily: DailyStats;
}

const MAX_CLOSED_TRADES = 2000;
const MAX_SEEN_TOKENS = 20_000;

function emptyDaily(): DailyStats {
  return {
    date: new Date().toISOString().slice(0, 10),
    spentUsdc: 0,
    realizedPnlUsdc: 0,
    buys: 0,
    sells: 0,
  };
}

/**
 * Atomic writes only. Every save goes to a temp file in the same directory, is
 * fsync'd, then renamed over the target — a crash mid-write can never leave a
 * truncated positions file, which would lose track of real money.
 */
function writeAtomic(file: string, contents: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export class StateManager {
  private readonly stateFile: string;
  private readonly seenFile: string;
  private state: BotState;
  private seen: Set<string>;
  private seenOrder: string[];

  constructor(private readonly dataDir: string) {
    this.stateFile = path.join(dataDir, 'state.json');
    this.seenFile = path.join(dataDir, 'seen_tokens.json');
    this.state = { version: 1, positions: [], closed: [], daily: emptyDaily() };
    this.seen = new Set();
    this.seenOrder = [];
  }

  load(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });

    if (fs.existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<BotState>;
        this.state = {
          version: 1,
          positions: Array.isArray(parsed.positions) ? parsed.positions : [],
          closed: Array.isArray(parsed.closed) ? parsed.closed : [],
          daily: parsed.daily ?? emptyDaily(),
        };
        logger.info('STATE_LOADED', {
          positions: this.state.positions.length,
          closed: this.state.closed.length,
        });
      } catch (err) {
        // Do not silently start with an empty book — that would re-buy tokens we
        // already hold. Move the bad file aside and refuse to guess.
        const backup = `${this.stateFile}.corrupt.${Date.now()}`;
        fs.renameSync(this.stateFile, backup);
        logger.error('STATE_LOAD_FAILED', { error: String(err), backup });
        throw new Error(
          `state.json is unreadable and was moved to ${backup}. ` +
            'Inspect it for open positions before restarting.',
        );
      }
    }

    if (fs.existsSync(this.seenFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.seenFile, 'utf8')) as unknown;
        if (Array.isArray(parsed)) {
          this.seenOrder = parsed.filter((v): v is string => typeof v === 'string');
          this.seen = new Set(this.seenOrder);
        }
      } catch (err) {
        logger.warn('SEEN_TOKENS_LOAD_FAILED', { error: String(err) });
      }
    }

    this.rollDailyIfNeeded();
  }

  save(): void {
    writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  saveSeen(): void {
    writeAtomic(this.seenFile, JSON.stringify(this.seenOrder));
  }

  saveAll(): void {
    this.save();
    this.saveSeen();
  }

  // --- seen tokens -----------------------------------------------------

  hasSeen(mint: string): boolean {
    return this.seen.has(mint);
  }

  markSeen(mint: string): void {
    if (this.seen.has(mint)) return;
    this.seen.add(mint);
    this.seenOrder.push(mint);
    if (this.seenOrder.length > MAX_SEEN_TOKENS) {
      const dropped = this.seenOrder.splice(0, this.seenOrder.length - MAX_SEEN_TOKENS);
      for (const m of dropped) this.seen.delete(m);
    }
  }

  seenCount(): number {
    return this.seen.size;
  }

  // --- positions -------------------------------------------------------

  getPositions(): Position[] {
    return this.state.positions;
  }

  getPosition(mint: string): Position | undefined {
    return this.state.positions.find((p) => p.mint === mint);
  }

  holdsPosition(mint: string): boolean {
    return this.state.positions.some((p) => p.mint === mint);
  }

  addPosition(pos: Position): void {
    this.state.positions.push(pos);
    this.rollDailyIfNeeded();
    this.state.daily.spentUsdc += pos.entryUsdc;
    this.state.daily.buys += 1;
    this.save();
  }

  removePosition(mint: string): void {
    this.state.positions = this.state.positions.filter((p) => p.mint !== mint);
    this.save();
  }

  recordClose(trade: ClosedTrade): void {
    this.state.closed.push(trade);
    if (this.state.closed.length > MAX_CLOSED_TRADES) {
      this.state.closed = this.state.closed.slice(-MAX_CLOSED_TRADES);
    }
    this.rollDailyIfNeeded();
    this.state.daily.realizedPnlUsdc += trade.pnlUsdc;
    this.state.daily.sells += 1;
    this.save();
  }

  /** Realized P&L from a partial sell, booked without closing the position. */
  recordPartialRealized(pnlUsdc: number): void {
    this.rollDailyIfNeeded();
    this.state.daily.realizedPnlUsdc += pnlUsdc;
    this.state.daily.sells += 1;
    this.save();
  }

  getClosed(): ClosedTrade[] {
    return this.state.closed;
  }

  // --- daily rails -----------------------------------------------------

  private rollDailyIfNeeded(): void {
    const date = new Date().toISOString().slice(0, 10);
    if (this.state.daily.date !== date) {
      logger.info('DAILY_ROLLOVER', {
        previous: this.state.daily.date,
        spent_usdc: round(this.state.daily.spentUsdc),
        realized_pnl_usdc: round(this.state.daily.realizedPnlUsdc),
        buys: this.state.daily.buys,
        sells: this.state.daily.sells,
      });
      this.state.daily = emptyDaily();
    }
  }

  getDaily(): DailyStats {
    this.rollDailyIfNeeded();
    return this.state.daily;
  }
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
