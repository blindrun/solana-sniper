import WebSocket from 'ws';
import { httpJson, RateLimiter, sleep } from '../http.js';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

const BASE = 'https://api.dexscreener.com';
const WS_URL = 'wss://io.dexscreener.com/dex/screener/pairs/h24/1';

/** DexScreener's documented budget is 300 req/min. Held at 280 for headroom. */
const LIMITER = new RateLimiter(280, 280 / 60, 'dexscreener');

export interface DexTxnBucket {
  buys: number;
  sells: number;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name?: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', DexTxnBucket>>;
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  /** Unix ms. Absent on some very new pairs, which the scorer treats as unknown age. */
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { label?: string; url: string }[];
    socials?: { type?: string; platform?: string; url: string }[];
  };
}

export interface TokenProfile {
  url?: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
  links?: { type?: string; label?: string; url: string }[];
}

export interface BoostedToken {
  url?: string;
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
}

export class DexScreenerClient {
  constructor(private readonly cfg: Config) {}

  /** Newest token profiles. This is the primary discovery feed. */
  async latestTokenProfiles(): Promise<TokenProfile[]> {
    const data = await httpJson<TokenProfile[] | { profiles?: TokenProfile[] }>(
      `${BASE}/token-profiles/latest/v1`,
      { label: 'dexscreener.token-profiles', limiter: LIMITER },
    );
    const arr = Array.isArray(data) ? data : (data.profiles ?? []);
    return arr.filter((p) => p && p.chainId === this.cfg.chain && p.tokenAddress);
  }

  /** Boosted tokens — paid promotion, so treated as a supplementary feed, never a quality signal. */
  async latestBoosts(): Promise<BoostedToken[]> {
    const data = await httpJson<BoostedToken[] | { boosts?: BoostedToken[] }>(
      `${BASE}/token-boosts/latest/v1`,
      { label: 'dexscreener.token-boosts', limiter: LIMITER },
    );
    const arr = Array.isArray(data) ? data : (data.boosts ?? []);
    return arr.filter((b) => b && b.chainId === this.cfg.chain && b.tokenAddress);
  }

  async pairsForToken(tokenAddress: string): Promise<DexPair[]> {
    const data = await httpJson<{ pairs?: DexPair[] | null }>(
      `${BASE}/latest/dex/tokens/${tokenAddress}`,
      { label: 'dexscreener.token', limiter: LIMITER },
    );
    return (data.pairs ?? []).filter((p) => p && p.chainId === this.cfg.chain);
  }

  async pair(pairAddress: string): Promise<DexPair | null> {
    const data = await httpJson<{ pairs?: DexPair[] | null; pair?: DexPair | null }>(
      `${BASE}/latest/dex/pairs/${this.cfg.chain}/${pairAddress}`,
      { label: 'dexscreener.pair', limiter: LIMITER },
    );
    return data.pair ?? data.pairs?.[0] ?? null;
  }

  async search(query: string): Promise<DexPair[]> {
    const data = await httpJson<{ pairs?: DexPair[] | null }>(
      `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
      { label: 'dexscreener.search', limiter: LIMITER },
    );
    return (data.pairs ?? []).filter((p) => p && p.chainId === this.cfg.chain);
  }

  /**
   * Picks the pair a position should be judged and traded against: deepest
   * liquidity wins. A token often has several pools and the shallow ones give
   * both a misleading price and an unfillable exit.
   */
  static bestPair(pairs: DexPair[], tokenAddress: string): DexPair | null {
    const owned = pairs.filter(
      (p) => p.baseToken?.address === tokenAddress || p.quoteToken?.address === tokenAddress,
    );
    if (owned.length === 0) return null;
    return owned.reduce((best, p) =>
      (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best,
    );
  }
}

/**
 * Best-effort real-time feed. The endpoint is undocumented and rejects clients
 * that do not look like the website, so it is treated purely as a hint: it only
 * ever emits mint addresses, which the REST path then re-verifies. If it keeps
 * failing it disables itself rather than reconnecting forever.
 */
export class DexScreenerWebSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private failures = 0;
  private readonly maxFailures = 6;

  constructor(
    private readonly cfg: Config,
    private readonly onToken: (mint: string, pair: DexPair) => void,
  ) {}

  start(): void {
    if (!this.cfg.enableWebsocket) {
      logger.info('WEBSOCKET_DISABLED', { reason: 'ENABLE_WEBSOCKET=false' });
      return;
    }
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped && this.failures < this.maxFailures) {
      try {
        await this.connectOnce();
      } catch (err) {
        this.failures++;
        logger.warn('WEBSOCKET_ERROR', {
          error: err instanceof Error ? err.message : String(err),
          failures: this.failures,
        });
      }
      if (this.stopped) return;
      const backoff = Math.min(60_000, 2_000 * 2 ** this.failures);
      await sleep(backoff);
    }

    if (!this.stopped) {
      logger.warn('WEBSOCKET_GAVE_UP', {
        failures: this.failures,
        note: 'Falling back to REST polling only. Discovery still works, just slower.',
      });
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: {
          Origin: 'https://dexscreener.com',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      this.ws = ws;

      const openTimer = setTimeout(() => {
        ws.terminate();
        reject(new Error('websocket open timeout'));
      }, 15_000);

      ws.on('open', () => {
        clearTimeout(openTimer);
        this.failures = 0;
        logger.info('WEBSOCKET_CONNECTED', { url: WS_URL });
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as { pairs?: DexPair[] };
          if (!Array.isArray(msg.pairs)) return;
          for (const pair of msg.pairs) {
            if (pair?.chainId !== this.cfg.chain) continue;
            const mint = pair.baseToken?.address;
            if (mint) this.onToken(mint, pair);
          }
        } catch {
          // Non-JSON frames (heartbeats) are expected; ignore.
        }
      });

      ws.on('close', (code) => {
        clearTimeout(openTimer);
        logger.debug('WEBSOCKET_CLOSED', { code });
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(openTimer);
        reject(err);
      });
    });
  }
}
