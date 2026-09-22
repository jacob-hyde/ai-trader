/**
 * Test doubles for Alpaca: a scripted fetch and a local websocket server that speaks both stream
 * protocols. Not exported from the package; the paper adapter's tests (F.3) import it by path.
 *
 * The stream server follows what the real one was seen to do (2026-09-22): the data stream speaks first
 * with "connected", answers auth, acknowledges every subscription change with the full current set in
 * no particular order, and refuses a second connection on the account with 406. The trading stream
 * answers in binary frames.
 */

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export interface FetchCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
  /** Date.now() when the request left, so rate tests can check spacing under fake timers. */
  readonly at: number;
}

export type FetchHandler = (call: FetchCall, signal: AbortSignal | null) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that records every call and answers from the handler. */
export function fakeFetch(handler: FetchHandler): {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === "string" ? init.body : undefined;
    const call: FetchCall = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: text === undefined ? undefined : (JSON.parse(text) as unknown),
      at: Date.now(),
    };
    calls.push(call);
    return handler(call, init?.signal ?? null);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

/** Never answers; rejects the way fetch does when the timeout signal fires. */
export function hang(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason as Error));
  });
}

export type StreamProtocol = "marketData" | "tradeUpdates";

interface Connection {
  readonly socket: WebSocket;
  authenticated: boolean;
  readonly subscriptions: Record<string, Set<string>>;
}

export interface MockStreamServerOptions {
  readonly protocol: StreamProtocol;
  readonly keyId: string;
  readonly secretKey: string;
  /** False makes the server ignore pings, like a peer that has silently gone. */
  readonly autoPong?: boolean;
}

const CHANNELS = ["bars", "updatedBars", "dailyBars", "quotes", "trades", "statuses"] as const;

export class MockStreamServer {
  readonly #http: Server;
  readonly #server: WebSocketServer;
  readonly #options: MockStreamServerOptions;
  readonly #connections = new Set<Connection>();
  /** Every message any client sent, parsed. */
  readonly received: Array<Record<string, unknown>> = [];
  /** Connections accepted so far. */
  accepted = 0;
  /** Error codes to answer the next auth attempts with, one per attempt, e.g. [406]. */
  refuseAuthWith: number[] = [];
  /** Say nothing on connect: the client's handshake deadline should fire. */
  silent = false;
  /** Leave subscription changes unacknowledged. */
  acknowledge = true;
  /** Refuse a subscribe that would leave more symbols than this with 405. */
  symbolLimit = Number.POSITIVE_INFINITY;
  /** Answer "listen" with an empty stream list. */
  listenToNothing = false;
  /**
   * Hold the reply to the next auth, and stop reading from that client, until releaseAuth(). Lets a test
   * act between the client sending its auth and the answer arriving.
   */
  holdAuth = false;
  #heldAuth: (() => void) | null = null;

  private constructor(http: Server, options: MockStreamServerOptions) {
    this.#http = http;
    this.#server = new WebSocketServer({ server: http, autoPong: options.autoPong ?? true });
    this.#options = options;
    this.#server.on("connection", (socket) => this.#accept(socket));
  }

  static start(options: MockStreamServerOptions): Promise<MockStreamServer> {
    return new Promise((resolve) => {
      const http = createServer();
      http.listen(0, "127.0.0.1", () => resolve(new MockStreamServer(http, options)));
    });
  }

  get port(): number {
    return (this.#http.address() as AddressInfo).port;
  }

  get origin(): string {
    return `ws://127.0.0.1:${String(this.port)}`;
  }

  /** Open connections right now. */
  get open(): number {
    return this.#connections.size;
  }

  /** Messages the clients sent with this action. */
  sent(action: string): Array<Record<string, unknown>> {
    return this.received.filter((message) => message["action"] === action);
  }

  /** Sends to every authenticated connection, in the protocol's framing. */
  push(message: unknown): void {
    for (const connection of this.#connections) {
      if (connection.authenticated) {
        this.#send(connection.socket, message);
      }
    }
  }

  /** Whether an auth reply is being held. */
  get authHeld(): boolean {
    return this.#heldAuth !== null;
  }

  /** Sends the held auth reply, then reads whatever the client sent meanwhile. */
  releaseAuth(): void {
    const release = this.#heldAuth;
    this.#heldAuth = null;
    release?.();
  }

  /** Sends this text as is, framing and all, e.g. a frame that is not JSON. */
  pushRaw(text: string): void {
    for (const connection of this.#connections) {
      connection.socket.send(text);
    }
  }

  /** Cuts every connection without a close frame, like a network drop. */
  dropAll(): void {
    for (const connection of this.#connections) {
      connection.socket.terminate();
    }
  }

  /**
   * Stops listening and cuts every TCP connection, upgraded or not. A connection caught halfway through
   * its upgrade would otherwise hold the HTTP server open, and the test's teardown with it.
   */
  async stop(): Promise<void> {
    this.dropAll();
    this.#server.close();
    await new Promise<void>((resolve) => {
      this.#http.close(() => resolve());
      this.#http.closeAllConnections();
    });
  }

  #accept(socket: WebSocket): void {
    this.accepted += 1;
    const connection: Connection = {
      socket,
      authenticated: false,
      subscriptions: Object.fromEntries(CHANNELS.map((channel) => [channel, new Set<string>()])),
    };
    this.#connections.add(connection);
    socket.on("close", () => this.#connections.delete(connection));
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      this.received.push(message);
      if (this.#options.protocol === "marketData") {
        this.#marketData(connection, message);
      } else {
        this.#tradeUpdates(connection, message);
      }
    });
    if (this.#options.protocol === "marketData" && !this.silent) {
      this.#send(socket, [{ T: "success", msg: "connected" }]);
    }
  }

  #credentialsMatch(key: unknown, secret: unknown): boolean {
    return key === this.#options.keyId && secret === this.#options.secretKey;
  }

  #marketData(connection: Connection, message: Record<string, unknown>): void {
    const { socket } = connection;
    if (message["action"] === "auth" && this.holdAuth) {
      this.holdAuth = false;
      socket.pause();
      this.#heldAuth = () => {
        this.#marketData(connection, message);
        socket.resume();
      };
      return;
    }
    if (message["action"] === "auth") {
      const refusal = this.refuseAuthWith.shift();
      if (refusal !== undefined) {
        this.#send(socket, [{ T: "error", code: refusal, msg: `refused with ${String(refusal)}` }]);
      } else if (!this.#credentialsMatch(message["key"], message["secret"])) {
        this.#send(socket, [{ T: "error", code: 402, msg: "auth failed" }]);
      } else {
        connection.authenticated = true;
        this.#send(socket, [{ T: "success", msg: "authenticated" }]);
      }
      return;
    }
    if (!connection.authenticated) {
      this.#send(socket, [{ T: "error", code: 401, msg: "not authenticated" }]);
      return;
    }
    const subscribing = message["action"] === "subscribe";
    if (subscribing || message["action"] === "unsubscribe") {
      const next = Object.fromEntries(
        CHANNELS.map((channel) => [channel, new Set(connection.subscriptions[channel])]),
      );
      for (const channel of CHANNELS) {
        for (const symbol of (message[channel] as string[] | undefined) ?? []) {
          if (subscribing) {
            next[channel]?.add(symbol);
          } else {
            next[channel]?.delete(symbol);
          }
        }
      }
      const symbols = new Set(Object.values(next).flatMap((set) => [...(set ?? [])]));
      if (symbols.size > this.symbolLimit) {
        this.#send(socket, [{ T: "error", code: 405, msg: "symbol limit exceeded" }]);
        return;
      }
      Object.assign(connection.subscriptions, next);
      if (this.acknowledge) {
        const ack: Record<string, unknown> = { T: "subscription" };
        for (const channel of CHANNELS) {
          const list = [...(connection.subscriptions[channel] ?? [])].reverse();
          // Like the real server: empty trades/quotes/bars are listed, other empty channels left out.
          if (list.length > 0 || channel === "trades" || channel === "quotes" || channel === "bars") {
            ack[channel] = list;
          }
        }
        this.#send(socket, [ack]);
      }
    }
  }

  #tradeUpdates(connection: Connection, message: Record<string, unknown>): void {
    const { socket } = connection;
    if (message["action"] === "auth") {
      const authorized = this.#credentialsMatch(message["key"], message["secret"]);
      connection.authenticated = authorized;
      this.#send(socket, {
        stream: "authorization",
        data: { action: "authenticate", status: authorized ? "authorized" : "unauthorized" },
      });
      return;
    }
    if (message["action"] === "listen" && connection.authenticated) {
      const streams = this.listenToNothing ? [] : (message["data"] as { streams: string[] }).streams;
      this.#send(socket, { stream: "listening", data: { streams } });
    }
  }

  #send(socket: WebSocket, message: unknown): void {
    const text = JSON.stringify(message);
    // The trading stream sends binary frames; the data stream sends text.
    socket.send(this.#options.protocol === "tradeUpdates" ? Buffer.from(text) : text, {
      binary: this.#options.protocol === "tradeUpdates",
    });
  }
}

/** Polls until the condition holds, or fails after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 2_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
