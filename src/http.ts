import { logger } from './logger.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Token-bucket limiter. DexScreener publishes 300 req/min on the endpoints this
 * bot uses; going over gets the IP throttled, which silently starves discovery
 * rather than throwing, so the budget is enforced client-side.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  /** Epoch ms until which the bucket is suspended after an observed 429. */
  private penaltyUntil = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly name: string,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Called when the server actually returns 429. A client-side budget is only a
   * guess at the server's real limit; this is the feedback that corrects it.
   * Without it the bot keeps spending its full budget into a closed door — which
   * is exactly how one hour produced 2,316 rejections on 2026-08-15.
   */
  penalize(ms = 5_000): void {
    this.tokens = 0;
    this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + ms);
    logger.warn('RATE_LIMIT_PENALTY', { limiter: this.name, penalty_ms: ms });
  }

  async take(cost = 1): Promise<void> {
    for (;;) {
      const now = Date.now();

      // Refill is pinned to `now` while serving a penalty, so no tokens accrue
      // during it — otherwise the penalty would pay for itself.
      if (now < this.penaltyUntil) {
        this.lastRefill = now;
        await sleep(Math.min(this.penaltyUntil - now, 5_000));
        continue;
      }

      const elapsedSec = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = now;

      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }

      const waitMs = Math.ceil(((cost - this.tokens) / this.refillPerSec) * 1000);
      logger.debug('RATE_LIMIT_WAIT', { limiter: this.name, wait_ms: waitMs });
      await sleep(Math.min(waitMs, 5_000));
    }
  }
}

export interface HttpOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  limiter?: RateLimiter;
  /** Label used in logs so a failing endpoint is identifiable. */
  label: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly bodyText: string | null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * fetch with a timeout, a shared rate limiter and exponential backoff.
 * 4xx other than 429 are not retried — they will not become correct on a retry.
 */
export async function httpJson<T>(url: string, opts: HttpOptions): Promise<T> {
  const {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = 12_000,
    retries = 3,
    limiter,
    label,
  } = opts;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (limiter) await limiter.take();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(
          `${label}: HTTP ${res.status}`,
          res.status,
          text.slice(0, 500),
        );
        // Tell the limiter the server said no, and honour Retry-After when the
        // server bothers to send one rather than guessing over the top of it.
        if (res.status === 429 && limiter) {
          const retryAfterSec = Number(res.headers.get('retry-after'));
          limiter.penalize(
            Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? retryAfterSec * 1_000
              : 5_000,
          );
        }
        // Retry throttling and server-side faults; give up on the rest.
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === retries) throw err;
        lastErr = err;
        const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
        logger.warn('HTTP_RETRY', {
          label,
          status: res.status,
          attempt: attempt + 1,
          backoff_ms: backoff,
        });
        await sleep(backoff);
        continue;
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastErr = err;
      if (attempt === retries) break;
      const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn('HTTP_RETRY', {
        label,
        error: err instanceof Error ? err.message : String(err),
        attempt: attempt + 1,
        backoff_ms: backoff,
      });
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new HttpError(
    `${label}: failed after ${retries + 1} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
    null,
    null,
  );
}
