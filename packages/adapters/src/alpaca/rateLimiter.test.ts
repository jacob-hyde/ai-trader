import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_BACKOFF, assertBackoffPolicy, backoffDelay } from "./backoff.js";
import { ALPACA_TRADING_RATE_LIMIT, RateLimiter, alpacaDataRateLimit } from "./rateLimiter.js";

/** Most requests found in any window of `windowMs`, given the instants they left. */
function busiestWindow(times: readonly number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while ((times[end] as number) - (times[start] as number) >= windowMs) {
      start += 1;
    }
    best = Math.max(best, end - start + 1);
  }
  return best;
}

describe("backoffDelay", () => {
  const policy = { initialMs: 100, maxMs: 1_000, multiplier: 2 };

  it("keeps half the ceiling fixed and randomizes the other half", () => {
    expect(backoffDelay(0, policy, () => 0)).toBe(50);
    expect(backoffDelay(0, policy, () => 1)).toBe(100);
    expect(backoffDelay(2, policy, () => 0.5)).toBe(300);
  });

  it("caps at maxMs and treats a negative attempt as the first", () => {
    expect(backoffDelay(20, policy, () => 1)).toBe(1_000);
    expect(backoffDelay(-3, policy, () => 1)).toBe(100);
  });

  it("uses Math.random by default and stays inside the band", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ceiling = Math.min(5_000, 250 * 2 ** attempt);
      const delay = backoffDelay(attempt, DEFAULT_RETRY_BACKOFF);
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("refuses a policy that cannot back off", () => {
    expect(() => assertBackoffPolicy({ initialMs: 0, maxMs: 10, multiplier: 2 }, "p")).toThrow(RangeError);
    expect(() => assertBackoffPolicy({ initialMs: 10, maxMs: 5, multiplier: 2 }, "p")).toThrow(RangeError);
    expect(() => assertBackoffPolicy({ initialMs: 10, maxMs: 50, multiplier: 0.5 }, "p")).toThrow(RangeError);
    expect(() => assertBackoffPolicy(policy, "p")).not.toThrow();
  });
});

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a burst through at once, then paces at the window-safe refill rate", async () => {
    const limiter = new RateLimiter(ALPACA_TRADING_RATE_LIMIT);
    const times: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      void limiter.acquire().then(() => times.push(Date.now()));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toHaveLength(20);
    expect(limiter.waiting).toBe(2);
    // (200 - 20) per minute is one token every 333.3 ms.
    await vi.advanceTimersByTimeAsync(333);
    expect(times).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(21);
    await vi.advanceTimersByTimeAsync(334);
    expect(times).toHaveLength(22);
  });

  it("never lets more than the limit through in any window, however hard it is pushed", async () => {
    const limiter = new RateLimiter(ALPACA_TRADING_RATE_LIMIT);
    const times: number[] = [];
    for (let i = 0; i < 600; i += 1) {
      void limiter.acquire().then(() => times.push(Date.now()));
    }
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(times).toHaveLength(600);
    expect(busiestWindow(times, 60_000)).toBeLessThanOrEqual(200);
    // And not needlessly slow: the first minute carries the burst plus a full minute of refill.
    expect(times.filter((t) => t < 1_000_000 + 60_000).length).toBeGreaterThanOrEqual(199);
  });

  it("serves high priority ahead of the normal queue", async () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1_000, burst: 1 });
    const order: string[] = [];
    await limiter.acquire();
    void limiter.acquire("normal").then(() => order.push("read 1"));
    void limiter.acquire("normal").then(() => order.push("read 2"));
    void limiter.acquire("high").then(() => order.push("order"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["order", "read 1", "read 2"]);
  });

  it("holds everything while paused, and ignores a pause that ends sooner", async () => {
    const limiter = new RateLimiter(ALPACA_TRADING_RATE_LIMIT);
    limiter.pauseUntil(Date.now() + 5_000);
    limiter.pauseUntil(Date.now() + 1_000);
    let done = false;
    void limiter.acquire().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("takes the server's remaining count when it is lower, and pauses at zero until the reset", async () => {
    const limiter = new RateLimiter(ALPACA_TRADING_RATE_LIMIT);
    limiter.observe(null, null);
    limiter.observe(2, Date.now() + 60_000);
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      void limiter.acquire().then(() => times.push(Date.now()));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toHaveLength(2);

    limiter.observe(0, Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(times).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(3);
  });

  it("sizes the data API's burst from its plan", () => {
    expect(alpacaDataRateLimit(200)).toEqual({ limit: 200, windowMs: 60_000, burst: 20 });
    expect(alpacaDataRateLimit(10_000).burst).toBe(1_000);
    expect(alpacaDataRateLimit(5).burst).toBe(1);
  });

  it("refuses a policy whose burst alone could break the limit", () => {
    expect(() => new RateLimiter({ limit: 10, windowMs: 1_000, burst: 10 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 10, windowMs: 1_000, burst: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 10.5, windowMs: 1_000, burst: 1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 10, windowMs: 0, burst: 1 })).toThrow(RangeError);
  });
});
