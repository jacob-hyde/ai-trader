/**
 * What a setup says when its entry condition is met, and the words it says it in.
 */

import { z } from "zod";
import { type Fixed, fixedSchema } from "./money.js";
import { type SessionDate, minuteOfSessionSchema, sessionDateSchema } from "./time.js";

export type Direction = "long" | "short";
export const DIRECTIONS = ["long", "short"] as const;
export const directionSchema = z.enum(DIRECTIONS);

/** How an entry order rests at the broker. A stop entry fills as a market order into momentum. */
export type EntryType = "stop" | "limit" | "market";
export const ENTRY_TYPES = ["stop", "limit", "market"] as const;
export const entryTypeSchema = z.enum(ENTRY_TYPES);

/** An exact entry condition that has been met on closed bars. Carries no size, stop, or target. */
export interface SetupSignal {
  readonly setupId: string;
  readonly setupVersion: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly session: SessionDate;
  /** Minute of the closed bar that completed the condition. */
  readonly minuteOfSession: number;
  readonly entryType: EntryType;
  /** Trigger price for a stop entry, limit price for a limit entry, reference price for a market entry. */
  readonly entry: Fixed;
  /**
   * Named prices the setup measured, e.g. the opening range's high and low. How stop and target reach
   * what the detector saw without being handed the bars again, and what the decision log shows.
   */
  readonly levels: Readonly<Record<string, Fixed>>;
}

export const setupSignalSchema: z.ZodType<SetupSignal, z.ZodTypeDef, unknown> = z.object({
  setupId: z.string().min(1),
  setupVersion: z.string().min(1),
  symbol: z.string().min(1),
  direction: directionSchema,
  session: sessionDateSchema,
  minuteOfSession: minuteOfSessionSchema,
  entryType: entryTypeSchema,
  entry: fixedSchema,
  levels: z.record(z.string(), fixedSchema),
});
