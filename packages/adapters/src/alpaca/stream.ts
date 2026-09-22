/**
 * A websocket that stays up: handshake, liveness pings, and reconnect with backoff.
 *
 * Both Alpaca streams (market data, trade updates) sit on this. The subclass speaks the protocol: what to
 * send on open, how to read a frame, when the handshake is done. This class owns the socket's life.
 *
 * States run idle, connecting, authenticating, ready. A drop from any of them goes to reconnecting, then
 * connecting again after a backoff delay. Two ends are terminal: closed (the owner called close()) and
 * failed (the server refused in a way reconnecting cannot fix, e.g. bad credentials).
 *
 * A connection is judged alive by pings. One that has not answered by the next ping is dropped and
 * reopened, so a half-open TCP connection (the peer gone without a FIN) is caught within two intervals
 * rather than never. The handshake has its own deadline for the same reason.
 *
 * Anything the server sent while the stream was down is lost. `reconnect` says so, and the engine
 * reconciles against REST (G.3); nothing here replays.
 *
 * Handlers run synchronously on the socket's message callback. A handler that throws is a bug in the
 * handler and propagates, as with every Emitter in this package.
 */

import WebSocket from "ws";
import { Emitter } from "../events.js";
import { type BackoffPolicy, backoffDelay } from "./backoff.js";
import { AlpacaStreamError, type AlpacaStreamName } from "./errors.js";
import type { Logger } from "./logger.js";
import type { Credentials } from "./rest.js";

export type StreamState =
  "idle" | "connecting" | "authenticating" | "ready" | "reconnecting" | "closed" | "failed";

export interface StreamOptions {
  readonly url: string;
  readonly credentials: Credentials;
  readonly reconnectBackoff: BackoffPolicy;
  /** Ping interval. A connection that has not answered by the next ping is dropped and reopened. */
  readonly heartbeatMs: number;
  /** From opening the socket to ready. Past it the attempt is dropped and retried. */
  readonly handshakeTimeoutMs: number;
  readonly logger: Logger;
  readonly random: () => number;
}

export type StreamEvents = {
  /** A ready connection dropped. Reconnecting starts on its own unless the stream failed or was closed. */
  disconnect: { readonly at: string; readonly reason: string };
  /** Ready again after a drop. Whatever happened in between was not delivered. */
  reconnect: { readonly at: string; readonly attempts: number };
  /** A problem the stream reports. `fatal` ones end it; the rest it survives. */
  error: AlpacaStreamError;
};

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function toText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

export abstract class ManagedStream<Events extends StreamEvents> extends Emitter<Events> {
  protected abstract readonly name: AlpacaStreamName;
  protected readonly logger: Logger;

  readonly #url: string;
  readonly #credentials: Credentials;
  readonly #backoff: BackoffPolicy;
  readonly #heartbeatMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #random: () => number;

  #state: StreamState = "idle";
  #socket: WebSocket | null = null;
  #everReady = false;
  /** Failed attempts since the stream was last ready. */
  #failures = 0;
  #alive = true;
  #dropReason: string | null = null;
  #fatal: AlpacaStreamError | null = null;
  #readyWaiters: Waiter[] = [];
  #closeWaiters: Array<() => void> = [];
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StreamOptions) {
    super();
    this.#url = options.url;
    this.#credentials = options.credentials;
    this.#backoff = options.reconnectBackoff;
    this.#heartbeatMs = options.heartbeatMs;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.logger = options.logger;
    this.#random = options.random;
  }

  get state(): StreamState {
    return this.#state;
  }

  /**
   * Opens the stream and resolves once it is ready. Transient failures are retried under the hood with
   * backoff, so this waits through them; race it with a timeout if the caller cannot. Rejects when the
   * stream fails for good or is closed first. Idempotent.
   */
  connect(): Promise<void> {
    if (this.#state === "ready") {
      return Promise.resolve();
    }
    const unusable = this.unusable();
    if (unusable !== null) {
      return Promise.reject(unusable);
    }
    const ready = new Promise<void>((resolve, reject) => this.#readyWaiters.push({ resolve, reject }));
    if (this.#state === "idle") {
      this.#open();
    }
    return ready;
  }

  /** Closes for good: no reconnect, pending calls reject. Idempotent. Resolves once the socket is shut. */
  close(): Promise<void> {
    if (this.#state === "closed" || this.#state === "failed") {
      return Promise.resolve();
    }
    this.#clearTimers();
    const socket = this.#socket;
    this.#state = "closed";
    if (socket === null) {
      this.#settleClosed();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#closeWaiters.push(resolve);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client closing");
        // A peer that never answers the close frame does not get to hold this up.
        setTimeout(() => socket.terminate(), 2_000).unref();
      } else {
        socket.terminate();
      }
    });
  }

  /** The error a call should reject with when the stream can no longer be used, else null. */
  protected unusable(): AlpacaStreamError | null {
    if (this.#state === "failed") {
      return this.#fatal;
    }
    if (this.#state === "closed") {
      return new AlpacaStreamError(this.name, "closed", "the stream is closed");
    }
    return null;
  }

  /** What to do once the socket is open, e.g. send the auth message. */
  protected abstract onOpen(): void;

  /** One text frame from the server. Must not throw on bad input: report it instead. */
  protected abstract onText(text: string): void;

  /** The connection went away. Forget anything that belonged to it, e.g. acknowledged subscriptions. */
  protected abstract onConnectionLost(): void;

  /** The stream closed or failed for good. Reject whatever still waits on it. */
  protected abstract onEnded(error: AlpacaStreamError): void;

  /** Sends a message on the live socket. False when there is none. */
  protected send(message: unknown): boolean {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  /** Sends a message built from the credentials. The only way a subclass ever touches them. */
  protected sendAuth(build: (credentials: Credentials) => unknown): boolean {
    return this.send(build(this.#credentials));
  }

  /** The handshake is done. Ignored once the stream is closed or failed, so a late answer cannot revive it. */
  protected markReady(): void {
    if (!this.#live()) {
      return;
    }
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    const attempts = this.#failures;
    this.#failures = 0;
    this.#state = "ready";
    this.#startHeartbeat();
    const reconnected = this.#everReady;
    this.#everReady = true;
    this.logger.info("alpaca stream ready", { stream: this.name, reconnected, attempts });
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
    if (reconnected) {
      this.emit("reconnect", { at: new Date().toISOString(), attempts } as Events["reconnect"]);
    }
  }

  /** Reports a problem the stream survives. */
  protected report(error: AlpacaStreamError): void {
    this.logger.warn("alpaca stream error", { stream: this.name, kind: error.kind, code: error.code });
    this.emit("error", error as Events["error"]);
  }

  /** Drops the current connection and reconnects after backoff. */
  protected reconnect(reason: string): void {
    this.#drop(reason);
  }

  /** Ends the stream for good. */
  protected fail(error: AlpacaStreamError): void {
    if (this.#fatal !== null || this.#state === "closed") {
      return;
    }
    this.#fatal = error;
    this.logger.error("alpaca stream failed", { stream: this.name, kind: error.kind, code: error.code });
    this.emit("error", error as Events["error"]);
    this.#clearTimers();
    const socket = this.#socket;
    if (socket === null) {
      this.#state = "failed";
      this.#settleFailed();
    } else {
      socket.terminate();
    }
  }

  #open(): void {
    this.#state = "connecting";
    this.#dropReason = null;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    this.#handshakeTimer = setTimeout(() => {
      this.report(
        new AlpacaStreamError(
          this.name,
          "timeout",
          `not ready within ${String(this.#handshakeTimeoutMs)} ms of connecting`,
        ),
      );
      this.#drop("handshake timed out");
    }, this.#handshakeTimeoutMs);
    socket.on("open", () => {
      if (socket === this.#socket && this.#live()) {
        this.#state = "authenticating";
        this.onOpen();
      }
    });
    socket.on("message", (data) => {
      // Frames still in flight after close() or a fatal error are dropped. A late "authenticated" would
      // otherwise mark the stream ready again, and the socket's close would then look like a drop.
      if (socket === this.#socket && this.#live()) {
        this.#alive = true;
        this.onText(toText(data));
      }
    });
    socket.on("pong", () => {
      this.#alive = true;
    });
    socket.on("error", (error) => {
      // A close always follows, and the close decides what happens next.
      this.logger.warn("alpaca stream socket error", { stream: this.name, message: error.message });
    });
    socket.on("close", (code, reason) => this.#onClose(socket, code, reason.toString("utf8")));
  }

  #onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#socket = null;
    const wasReady = this.#state === "ready";
    this.#clearTimers();
    this.onConnectionLost();
    if (this.#state === "closed") {
      this.#settleClosed();
      return;
    }
    if (this.#fatal !== null) {
      this.#state = "failed";
      this.#settleFailed();
      return;
    }
    const why =
      this.#dropReason ?? `closed by the server (${String(code)}${reason === "" ? "" : ` ${reason}`})`;
    if (wasReady) {
      this.emit("disconnect", { at: new Date().toISOString(), reason: why } as Events["disconnect"]);
    }
    const delay = backoffDelay(this.#failures, this.#backoff, this.#random);
    this.#failures += 1;
    this.#state = "reconnecting";
    this.logger.warn("alpaca stream reconnecting", {
      stream: this.name,
      reason: why,
      attempt: this.#failures,
      delayMs: delay,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  /** Neither closed by the owner nor failed. */
  #live(): boolean {
    return this.#state !== "closed" && this.#fatal === null;
  }

  #drop(reason: string): void {
    const socket = this.#socket;
    if (socket !== null) {
      this.#dropReason ??= reason;
      socket.terminate();
    }
  }

  #startHeartbeat(): void {
    this.#alive = true;
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#alive) {
        this.#drop(`no pong within ${String(this.#heartbeatMs)} ms`);
        return;
      }
      this.#alive = false;
      this.#socket?.ping();
    }, this.#heartbeatMs);
  }

  #clearTimers(): void {
    for (const timer of [this.#reconnectTimer, this.#handshakeTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
    }
    this.#reconnectTimer = null;
    this.#handshakeTimer = null;
    this.#heartbeatTimer = null;
  }

  #settleClosed(): void {
    this.#rejectReady(new AlpacaStreamError(this.name, "closed", "closed before it was ready"));
    const waiters = this.#closeWaiters;
    this.#closeWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  #settleFailed(): void {
    this.#rejectReady(this.#fatal as AlpacaStreamError);
  }

  #rejectReady(error: AlpacaStreamError): void {
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
    this.onEnded(error);
  }
}
