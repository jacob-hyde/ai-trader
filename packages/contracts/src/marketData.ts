/**
 * What the data half of an adapter returns beyond bars and quotes.
 */

import { z } from "zod";
import { type Bar, type Quote, barSchema, quoteSchema } from "./bars.js";
import { type Fixed, fixedSchema } from "./money.js";
import { type IsoTimestamp, isoTimestampSchema } from "./time.js";

/** One symbol's latest state, hydrated in a batch. Any part the feed lacks is null. */
export interface SymbolSnapshot {
  readonly symbol: string;
  readonly asOf: IsoTimestamp;
  readonly lastTrade: { readonly price: Fixed; readonly at: IsoTimestamp } | null;
  readonly quote: Quote | null;
  readonly minuteBar: Bar | null;
  readonly dailyBar: Bar | null;
  readonly previousDailyBar: Bar | null;
}

export const symbolSnapshotSchema: z.ZodType<SymbolSnapshot, z.ZodTypeDef, unknown> = z.object({
  symbol: z.string().min(1),
  asOf: isoTimestampSchema,
  lastTrade: z.object({ price: fixedSchema, at: isoTimestampSchema }).nullable(),
  quote: quoteSchema.nullable(),
  minuteBar: barSchema.nullable(),
  dailyBar: barSchema.nullable(),
  previousDailyBar: barSchema.nullable(),
});

export type ScreenerKind = "mostActives" | "topGainers" | "topLosers";
export const screenerKindSchema = z.enum(["mostActives", "topGainers", "topLosers"]);

/** One row of a screener pull, as ranked by the source. */
export interface ScreenerRow {
  readonly symbol: string;
  readonly rank: number;
  readonly lastPrice: Fixed;
  readonly volume: number;
  /** Change on the day in basis points, null when the source does not give one. */
  readonly changeBps: number | null;
}

export const screenerRowSchema: z.ZodType<ScreenerRow, z.ZodTypeDef, unknown> = z.object({
  symbol: z.string().min(1),
  rank: z.number().int().positive(),
  lastPrice: fixedSchema,
  volume: z.number().int().min(0),
  changeBps: z.number().int().nullable(),
});

export interface NewsItem {
  readonly id: string;
  readonly headline: string;
  readonly summary: string;
  readonly source: string;
  readonly url: string | null;
  readonly symbols: readonly string[];
  readonly publishedAt: IsoTimestamp;
}

export const newsItemSchema: z.ZodType<NewsItem, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  headline: z.string(),
  summary: z.string(),
  source: z.string(),
  url: z.string().url().nullable(),
  symbols: z.array(z.string().min(1)),
  publishedAt: isoTimestampSchema,
});
