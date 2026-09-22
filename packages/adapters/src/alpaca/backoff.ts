/**
 * Exponential backoff with jitter, for GET retries and websocket reconnects.
 */

export interface BackoffPolicy {
  /** Ceiling of the first delay. */
  readonly initialMs: number;
  /** No delay exceeds this. */
  readonly maxMs: number;
  /** Growth of the ceiling per attempt. */
  readonly multiplier: number;
}

/** Retries of a failed GET. Four attempts at these settings wait at most about 1.75 s in total. */
export const DEFAULT_RETRY_BACKOFF: BackoffPolicy = { initialMs: 250, maxMs: 5_000, multiplier: 2 };

/** Websocket reconnects. Reaches the 30 s ceiling after about six failed attempts. */
export const DEFAULT_RECONNECT_BACKOFF: BackoffPolicy = { initialMs: 500, maxMs: 30_000, multiplier: 2 };

/**
 * The delay before retry number `attempt`, counting from 0.
 *
 * Equal jitter: half the ceiling is fixed and half is random, so the delay still grows under bad luck
 * and a flapping server is never hammered, while clients that failed together do not retry together.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxMs, policy.initialMs * policy.multiplier ** Math.max(0, attempt));
  const half = ceiling / 2;
  return Math.round(half + half * random());
}

/** Throws on a policy that cannot produce sensible delays. */
export function assertBackoffPolicy(policy: BackoffPolicy, what: string): void {
  if (!(policy.initialMs > 0 && policy.maxMs >= policy.initialMs && policy.multiplier >= 1)) {
    throw new RangeError(`${what}: needs initialMs > 0, maxMs >= initialMs, multiplier >= 1`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
