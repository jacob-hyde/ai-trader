/**
 * What can go wrong talking to Alpaca, and what the caller may do about it.
 *
 * The two flags carry the decision. `retryable` says the same request may be sent again unchanged: a
 * rate limit, a 5xx or a dropped connection on a read. `outcomeUnknown` says a request that changes state
 * may or may not have reached the broker, e.g. an order POST that timed out. The caller must look before
 * sending it again (by client order id) or it risks doubling the order. The client itself never resends
 * anything but a GET.
 *
 * Messages carry the method, the path, the status, and Alpaca's own message. Never a header, so never a key.
 */

export type AlpacaErrorKind =
  /** Alpaca answered with a non-2xx status other than 429. */
  | "http"
  /** 429. The server refused before doing anything, so the request is safe to repeat later. */
  | "rateLimited"
  /** No response: DNS, refused connection, reset. */
  | "network"
  /** No response within the client's timeout. */
  | "timeout"
  /** Refused locally before sending, e.g. an order request with a malformed price. */
  | "invalidRequest"
  /**
   * Alpaca answered 2xx with a body the schema rejects. For a request that changes state the broker has
   * accepted it, so `status` is 2xx and the action happened even though the body could not be read.
   */
  | "invalidResponse";

export class AlpacaError extends Error {
  readonly kind: AlpacaErrorKind;
  readonly method: string;
  /** Path and query, e.g. "/v2/orders?status=open". */
  readonly path: string;
  /** HTTP status, null when no response arrived. */
  readonly status: number | null;
  /** Alpaca's code from the body, e.g. 40310000. Null when the body had none. */
  readonly alpacaCode: number | null;
  /** The same request may be sent again unchanged. */
  readonly retryable: boolean;
  /** A state-changing request may have reached the broker. Reconcile before sending it again. */
  readonly outcomeUnknown: boolean;
  /** How long the server asked us to wait, when it said. */
  readonly retryAfterMs: number | null;

  constructor(
    init: {
      readonly kind: AlpacaErrorKind;
      readonly method: string;
      readonly path: string;
      readonly message: string;
      readonly status?: number | null;
      readonly alpacaCode?: number | null;
      readonly retryable?: boolean;
      readonly outcomeUnknown?: boolean;
      readonly retryAfterMs?: number | null;
    },
    options?: ErrorOptions,
  ) {
    super(`Alpaca ${init.method} ${init.path}: ${init.message}`, options);
    this.name = "AlpacaError";
    this.kind = init.kind;
    this.method = init.method;
    this.path = init.path;
    this.status = init.status ?? null;
    this.alpacaCode = init.alpacaCode ?? null;
    this.retryable = init.retryable ?? false;
    this.outcomeUnknown = init.outcomeUnknown ?? false;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

export type AlpacaStreamName = "marketData" | "tradeUpdates";

export type AlpacaStreamErrorKind =
  /** The server refused the credentials. Fatal: reconnecting cannot fix it. */
  | "auth"
  /** The account's plan does not include this feed. Fatal. */
  | "subscriptionPlan"
  /** Another connection holds the account's one market-data slot. Retried with backoff. */
  | "connectionLimit"
  /** The server refused a subscribe or unsubscribe, e.g. over the symbol limit. */
  | "subscription"
  /** A message that failed its schema. Dropped; the stream carries on. */
  | "invalidMessage"
  /** An error message from the server with no better category. */
  | "server"
  /** A handshake or a subscription acknowledgment did not arrive in time. */
  | "timeout"
  /** The stream was closed, or failed, while the call waited. */
  | "closed";

export class AlpacaStreamError extends Error {
  readonly kind: AlpacaStreamErrorKind;
  readonly stream: AlpacaStreamName;
  /** Alpaca's code from the error message, e.g. 406. Null for errors raised locally. */
  readonly code: number | null;
  /** The stream has stopped for good and will not reconnect. */
  readonly fatal: boolean;

  constructor(
    stream: AlpacaStreamName,
    kind: AlpacaStreamErrorKind,
    message: string,
    code: number | null = null,
    fatal = false,
  ) {
    super(`Alpaca ${stream} stream: ${message}`);
    this.name = "AlpacaStreamError";
    this.stream = stream;
    this.kind = kind;
    this.code = code;
    this.fatal = fatal;
  }
}
