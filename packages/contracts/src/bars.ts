/**
 * Bars and quotes as the whole system sees them.
 */

import { z } from "zod";
import { type Fixed, fixedSchema } from "./money.js";
import {
  type IsoTimestamp,
  type SessionDate,
  isoTimestampSchema,
  minuteOfSessionSchema,
  sessionDateSchema,
} from "./time.js";

/**
 * One OHLCV bar of a single symbol's series.
 *
 * Carries its session and its minute within that session, assigned upstream where the exchange
 * calendar lives, so "the first five minutes" is minutes 0 to 4 everywhere. `closed` is false while the
 * bar is still forming, and nothing downstream acts on such a bar.
 */
export interface Bar {
  readonly session: SessionDate;
  /** Minutes from the regular-session open to the bar's start. The 09:30 ET bar is 0. A daily bar is 0. */
  readonly minuteOfSession: number;
  readonly open: Fixed;
  readonly high: Fixed;
  readonly low: Fixed;
  readonly close: Fixed;
  /** Whole shares. */
  readonly volume: number;
  /** The bar's own volume-weighted price when the feed supplies one, else null. */
  readonly vwap: Fixed | null;
  readonly closed: boolean;
}

export const barSchema: z.ZodType<Bar, z.ZodTypeDef, unknown> = z.object({
  session: sessionDateSchema,
  minuteOfSession: minuteOfSessionSchema,
  open: fixedSchema,
  high: fixedSchema,
  low: fixedSchema,
  close: fixedSchema,
  volume: z.number().int().min(0),
  vwap: fixedSchema.nullable(),
  closed: z.boolean(),
});

/** A bar tagged with its symbol, as it travels as an event or a row. */
export interface SymbolBar extends Bar {
  readonly symbol: string;
}

export const symbolBarSchema: z.ZodType<SymbolBar, z.ZodTypeDef, unknown> = z.object({
  symbol: z.string().min(1),
  session: sessionDateSchema,
  minuteOfSession: minuteOfSessionSchema,
  open: fixedSchema,
  high: fixedSchema,
  low: fixedSchema,
  close: fixedSchema,
  volume: z.number().int().min(0),
  vwap: fixedSchema.nullable(),
  closed: z.boolean(),
});

/** The national best bid and offer. Never crossed: ask is at or above bid. */
export interface Quote {
  readonly bid: Fixed;
  readonly ask: Fixed;
}

export const quoteSchema: z.ZodType<Quote, z.ZodTypeDef, unknown> = z
  .object({ bid: fixedSchema, ask: fixedSchema })
  .refine((quote) => quote.ask >= quote.bid, { message: "a quote must not be crossed" });

/** A quote as an event: which symbol, and when. */
export interface QuoteEvent {
  readonly symbol: string;
  readonly quote: Quote;
  readonly at: IsoTimestamp;
}

export const quoteEventSchema: z.ZodType<QuoteEvent, z.ZodTypeDef, unknown> = z.object({
  symbol: z.string().min(1),
  quote: quoteSchema,
  at: isoTimestampSchema,
});
