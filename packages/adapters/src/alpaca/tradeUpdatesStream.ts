/**
 * The trading websocket's order events: new, fill, partial_fill, canceled, and the rest.
 *
 * Lives on the trading host, e.g. "wss://paper-api.alpaca.markets/stream". Paper sends every message
 * as a binary frame holding JSON, unlike the data stream's text frames; both are read the same way.
 *
 * An event missed while the stream was down is not resent. After `reconnect` the order state must be
 * re-read over REST (G.3 reconciliation), because a fill may have happened in the gap.
 */

import { z } from "zod";
import { AlpacaStreamError } from "./errors.js";
import { type AlpacaOrder, type Open, decimalString, orderSchema, timestamp } from "./schemas.js";
import { ManagedStream, type StreamEvents } from "./stream.js";

export const TRADE_UPDATE_EVENTS = [
  "new",
  "fill",
  "partial_fill",
  "canceled",
  "expired",
  "done_for_day",
  "replaced",
  "accepted",
  "rejected",
  "pending_new",
  "stopped",
  "pending_cancel",
  "pending_replace",
  "calculated",
  "suspended",
  "order_replace_rejected",
  "order_cancel_rejected",
] as const;
export type TradeUpdateEvent = Open<(typeof TRADE_UPDATE_EVENTS)[number]>;

export interface AlpacaTradeUpdate {
  readonly event: TradeUpdateEvent;
  /** The order as it stands after the event. */
  readonly order: AlpacaOrder;
  /** When the event happened. Fills and partial fills carry it; not every other event does. */
  readonly timestamp: string | null;
  /** Fills only: this execution's id, price, and quantity, and the position's size after it. */
  readonly execution_id: string | null;
  readonly price: string | null;
  readonly qty: string | null;
  readonly position_qty: string | null;
}

const nullishString = (schema: z.ZodString) => schema.nullish().transform((value) => value ?? null);

export const tradeUpdateSchema: z.ZodType<AlpacaTradeUpdate, z.ZodTypeDef, unknown> = z.object({
  event: z.string(),
  order: orderSchema,
  timestamp: nullishString(timestamp),
  execution_id: nullishString(z.string()),
  price: nullishString(decimalString),
  qty: nullishString(decimalString),
  position_qty: nullishString(decimalString),
});

const frameSchema = z.object({ stream: z.string(), data: z.unknown() });
const authorizationSchema = z.object({ status: z.string() });
const listeningSchema = z.object({ streams: z.array(z.string()) });

export type TradeUpdatesEvents = StreamEvents & {
  tradeUpdate: AlpacaTradeUpdate;
};

export class TradeUpdatesStream extends ManagedStream<TradeUpdatesEvents> {
  protected readonly name = "tradeUpdates";

  protected onOpen(): void {
    this.sendAuth(({ keyId, secretKey }) => ({ action: "auth", key: keyId, secret: secretKey }));
  }

  protected onText(text: string): void {
    let parsed: z.SafeParseReturnType<unknown, z.output<typeof frameSchema>>;
    try {
      parsed = frameSchema.safeParse(JSON.parse(text));
    } catch {
      this.report(new AlpacaStreamError(this.name, "invalidMessage", "a frame that is not JSON"));
      return;
    }
    if (!parsed.success) {
      this.report(new AlpacaStreamError(this.name, "invalidMessage", "a frame without stream and data"));
      return;
    }
    const { stream, data } = parsed.data;
    switch (stream) {
      case "authorization": {
        const status = authorizationSchema.safeParse(data);
        if (status.success && status.data.status === "authorized") {
          this.send({ action: "listen", data: { streams: ["trade_updates"] } });
        } else {
          this.fail(
            new AlpacaStreamError(this.name, "auth", "the server refused the credentials", null, true),
          );
        }
        return;
      }
      case "listening": {
        const listening = listeningSchema.safeParse(data);
        if (listening.success && listening.data.streams.includes("trade_updates")) {
          this.markReady();
        } else {
          this.report(new AlpacaStreamError(this.name, "server", "listening, but not to trade_updates"));
          this.reconnect("not listening to trade_updates");
        }
        return;
      }
      case "trade_updates": {
        const update = tradeUpdateSchema.safeParse(data);
        if (update.success) {
          this.emit("tradeUpdate", update.data);
        } else {
          this.report(new AlpacaStreamError(this.name, "invalidMessage", "a malformed trade update"));
        }
        return;
      }
      default:
        this.logger.debug("alpaca stream message ignored", { stream: this.name, type: stream });
    }
  }

  protected onConnectionLost(): void {
    // Nothing is held per connection.
  }

  protected onEnded(): void {
    // Nothing waits on this stream but connect(), which the base settles.
  }
}
