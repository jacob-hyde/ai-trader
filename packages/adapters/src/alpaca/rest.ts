/**
 * One Alpaca REST API (trading or market data): auth, rate limiting, timeouts, retries, parsing.
 *
 * Only GETs are retried: on a network error, a timeout, a 5xx, or a 429, up to `maxAttempts` in all.
 * Nothing that changes state is ever resent here. A POST, PATCH or DELETE that fails without a clear
 * answer throws with `outcomeUnknown`, and the caller reconciles (F.5) before trying again.
 *
 * The key and secret live in a private field and go out only as request headers. They are never in a
 * message, a log line, or an error.
 */

import type { z } from "zod";
import { type BackoffPolicy, backoffDelay, sleep } from "./backoff.js";
import { AlpacaError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { RateLimiter } from "./rateLimiter.js";

export interface Credentials {
  readonly keyId: string;
  readonly secretKey: string;
}

export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RestOptions {
  readonly baseUrl: string;
  readonly credentials: Credentials;
  readonly limiter: RateLimiter;
  readonly fetch: typeof fetch;
  /** Per attempt. */
  readonly timeoutMs: number;
  /** Attempts for a GET, the first included. Everything else gets exactly one. */
  readonly maxAttempts: number;
  readonly retryBackoff: BackoffPolicy;
  readonly logger: Logger;
  readonly random: () => number;
}

type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/** Joins arrays with commas and drops undefined, e.g. { symbols: ["A", "B"] } to "?symbols=A%2CB". */
export function queryString(query: Query | undefined): string {
  if (query === undefined) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Retry-After as seconds or an HTTP date, else X-RateLimit-Reset (epoch seconds), as ms from now. */
function serverWaitMs(headers: Headers, now: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const at = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.max(0, at - now);
    }
  }
  const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
  return Number.isFinite(reset) ? Math.max(0, reset * 1_000 - now) : null;
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Alpaca's error body is { code?, message }. Anything else is shown as its first few hundred characters. */
function describeBody(text: string): { message: string; code: number | null } {
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof body.message === "string") {
      return { message: body.message, code: typeof body.code === "number" ? body.code : null };
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return { message: text.slice(0, 300), code: null };
}

export class RestTransport {
  readonly #baseUrl: string;
  readonly #credentials: Credentials;
  readonly #limiter: RateLimiter;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryBackoff: BackoffPolicy;
  readonly #logger: Logger;
  readonly #random: () => number;

  constructor(options: RestOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#credentials = options.credentials;
    this.#limiter = options.limiter;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts;
    this.#retryBackoff = options.retryBackoff;
    this.#logger = options.logger;
    this.#random = options.random;
  }

  get<T>(path: string, schema: Schema<T>, query?: Query): Promise<T> {
    return this.#request("GET", path, query, undefined, schema);
  }

  /** A GET where 404 means "no such thing" rather than a failure, e.g. an order looked up by client id. */
  async getOrNull<T>(path: string, schema: Schema<T>, query?: Query): Promise<T | null> {
    try {
      return await this.get(path, schema, query);
    } catch (error) {
      if (error instanceof AlpacaError && error.kind === "http" && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** A state-changing request. Sent once, whatever happens. */
  send<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    schema: Schema<T>,
    body?: unknown,
    query?: Query,
  ): Promise<T>;
  send(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    schema: null,
    body?: unknown,
    query?: Query,
  ): Promise<void>;
  send<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    schema: Schema<T> | null,
    body?: unknown,
    query?: Query,
  ): Promise<T | undefined> {
    return this.#request(method, path, query, body, schema);
  }

  async #request<T>(
    method: Method,
    path: string,
    query: Query | undefined,
    body: unknown,
    schema: Schema<T> | null,
  ): Promise<T> {
    const target = `${path}${queryString(query)}`;
    const idempotent = method === "GET";
    const attempts = idempotent ? this.#maxAttempts : 1;
    for (let attempt = 0; ; attempt += 1) {
      await this.#limiter.acquire(idempotent ? "normal" : "high");
      const failure = await this.#attempt(method, target, body, schema, attempt);
      if (!(failure instanceof AlpacaError)) {
        return failure.value;
      }
      if (!idempotent || !failure.retryable || attempt + 1 >= attempts) {
        throw failure;
      }
      const delay =
        failure.kind === "rateLimited" ? 0 : backoffDelay(attempt, this.#retryBackoff, this.#random);
      this.#logger.warn("alpaca request retrying", {
        method,
        path: target,
        kind: failure.kind,
        status: failure.status,
        attempt: attempt + 1,
        delayMs: failure.kind === "rateLimited" ? failure.retryAfterMs : delay,
      });
      // A 429 has already paused the limiter until the server's time, so acquire() does the waiting.
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  async #attempt<T>(
    method: Method,
    target: string,
    body: unknown,
    schema: Schema<T> | null,
    attempt: number,
  ): Promise<{ value: T } | AlpacaError> {
    const mutation = method !== "GET";
    const headers: Record<string, string> = {
      "APCA-API-KEY-ID": this.#credentials.keyId,
      "APCA-API-SECRET-KEY": this.#credentials.secretKey,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${target}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const detail = error instanceof Error ? error.message : String(error);
      return new AlpacaError(
        {
          kind: timedOut ? "timeout" : "network",
          method,
          path: target,
          message: timedOut ? `no response within ${String(this.#timeoutMs)} ms` : `no response (${detail})`,
          retryable: !mutation,
          outcomeUnknown: mutation,
        },
        { cause: error },
      );
    }

    const now = Date.now();
    const reset = headerNumber(response.headers, "x-ratelimit-reset");
    this.#limiter.observe(
      headerNumber(response.headers, "x-ratelimit-remaining"),
      reset === null ? null : reset * 1_000,
    );

    const text = await response.text();
    if (response.ok) {
      return this.#parse(method, target, response.status, text, schema);
    }

    const { message, code } = describeBody(text);
    if (response.status === 429) {
      const hint = serverWaitMs(response.headers, now);
      const retryAfterMs = Math.max(hint ?? 0, backoffDelay(attempt, this.#retryBackoff, this.#random));
      this.#limiter.pauseUntil(now + retryAfterMs);
      return new AlpacaError({
        kind: "rateLimited",
        method,
        path: target,
        message: `429 ${message}`,
        status: 429,
        alpacaCode: code,
        retryable: true,
        retryAfterMs,
      });
    }
    const serverSide = response.status >= 500 || response.status === 408;
    return new AlpacaError({
      kind: "http",
      method,
      path: target,
      message: `${String(response.status)} ${message}`,
      status: response.status,
      alpacaCode: code,
      retryable: serverSide && !mutation,
      outcomeUnknown: serverSide && mutation,
    });
  }

  #parse<T>(
    method: Method,
    target: string,
    status: number,
    text: string,
    schema: Schema<T> | null,
  ): { value: T } | AlpacaError {
    if (schema === null) {
      return { value: undefined as T };
    }
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      return this.#invalid(method, target, status, "body is not JSON");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return this.#invalid(method, target, status, issues);
    }
    return { value: parsed.data };
  }

  #invalid(method: Method, target: string, status: number, detail: string): AlpacaError {
    return new AlpacaError({
      kind: "invalidResponse",
      method,
      path: target,
      message: `${String(status)} with an unexpected body: ${detail}`,
      status,
    });
  }
}
