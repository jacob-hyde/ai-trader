/**
 * Client-side rate limiting for one Alpaca API, so the engine stays under the limit instead of finding it.
 *
 * A token bucket sized so that a full burst plus a whole window of refill never exceeds the server's
 * per-window limit: `burst` tokens up front, then `limit - burst` spread evenly across the window. Alpaca
 * counts per key per minute, so any 60 s window holds at most `limit` requests from this process. The
 * cost is a sustained rate slightly under the nominal limit (180/min for the trading API's 200).
 *
 * The server's own view wins when it is stricter. Every response's X-RateLimit-Remaining caps the local
 * bucket, which catches other processes spending the same key (a bulk load next to the engine), and a
 * 429 or a remaining of 0 pauses the bucket until the time the server gives.
 *
 * High priority goes first. Order submits, cancels, and the panic flatten are never stuck behind a queue
 * of market-data reads or position polls.
 */

export interface RateLimitPolicy {
  /** Requests the server allows per window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Requests that may leave at once from a full bucket. Less than `limit`. */
  readonly burst: number;
}

/** Alpaca's trading API: 200 requests per minute per key, paper and live alike. */
export const ALPACA_TRADING_RATE_LIMIT: RateLimitPolicy = { limit: 200, windowMs: 60_000, burst: 20 };

/** Alpaca's market-data API at a plan's per-minute limit: 200 on Basic, 10,000 on Algo Trader Plus. */
export function alpacaDataRateLimit(requestsPerMinute: number): RateLimitPolicy {
  return {
    limit: requestsPerMinute,
    windowMs: 60_000,
    burst: Math.max(1, Math.floor(requestsPerMinute / 10)),
  };
}

export type Priority = "high" | "normal";

export class RateLimiter {
  readonly #burst: number;
  /** Tokens per millisecond. */
  readonly #rate: number;
  readonly #now: () => number;
  #tokens: number;
  #refilledAt: number;
  #pausedUntil = 0;
  readonly #high: Array<() => void> = [];
  readonly #normal: Array<() => void> = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(policy: RateLimitPolicy, now: () => number = () => Date.now()) {
    const { limit, windowMs, burst } = policy;
    if (!(
      Number.isInteger(limit) &&
      Number.isInteger(burst) &&
      burst >= 1 &&
      burst < limit &&
      windowMs > 0
    )) {
      throw new RangeError(
        "rate limit: needs whole limit and burst with 1 <= burst < limit, and windowMs > 0",
      );
    }
    this.#burst = burst;
    this.#rate = (limit - burst) / windowMs;
    this.#now = now;
    this.#tokens = burst;
    this.#refilledAt = now();
  }

  /** Resolves when a request may be sent. Waiters of equal priority go in arrival order. */
  acquire(priority: Priority = "normal"): Promise<void> {
    return new Promise((resolve) => {
      (priority === "high" ? this.#high : this.#normal).push(resolve);
      if (this.#timer === null) {
        this.#drain();
      }
    });
  }

  /** Holds every request until this instant (epoch ms). An earlier instant than the current pause is ignored. */
  pauseUntil(at: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, at);
  }

  /**
   * Folds in the server's count from a response. `remaining` caps the local bucket; a remaining of 0 with
   * a reset time pauses until then.
   */
  observe(remaining: number | null, resetAt: number | null): void {
    if (remaining === null) {
      return;
    }
    this.#refill(this.#now());
    this.#tokens = Math.min(this.#tokens, Math.max(0, remaining));
    if (remaining <= 0 && resetAt !== null) {
      this.pauseUntil(resetAt);
    }
  }

  /** Requests waiting for a token. */
  get waiting(): number {
    return this.#high.length + this.#normal.length;
  }

  #refill(now: number): void {
    if (now > this.#refilledAt) {
      this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#refilledAt) * this.#rate);
      this.#refilledAt = now;
    }
  }

  #drain(): void {
    this.#timer = null;
    while (this.waiting > 0) {
      const now = this.#now();
      if (now < this.#pausedUntil) {
        this.#schedule(this.#pausedUntil - now);
        return;
      }
      this.#refill(now);
      if (this.#tokens < 1) {
        this.#schedule(Math.ceil((1 - this.#tokens) / this.#rate));
        return;
      }
      this.#tokens -= 1;
      const next = this.#high.shift() ?? (this.#normal.shift() as () => void);
      next();
    }
  }

  #schedule(ms: number): void {
    this.#timer = setTimeout(() => this.#drain(), Math.max(1, ms));
  }
}
