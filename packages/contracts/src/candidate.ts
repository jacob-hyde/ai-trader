/**
 * A Stage-3 survivor: a name the hard gate let through, with the numbers it was judged on.
 */

import { z } from "zod";
import { type Fixed, type Ratio, fixedSchema, ratioSchema } from "./money.js";
import { type IsoTimestamp, type SessionDate, isoTimestampSchema, sessionDateSchema } from "./time.js";

export interface Candidate {
  readonly symbol: string;
  readonly session: SessionDate;
  readonly asOf: IsoTimestamp;
  readonly lastPrice: Fixed;
  /** Shares, over the lookback the gate uses. */
  readonly averageDailyVolume: number;
  readonly dailyAtr: Fixed;
  /** Opening relative volume in basis points. Null until the opening window has closed. */
  readonly openingRvol: Ratio | null;
  readonly spreadBps: Ratio;
  /** The cost-to-risk gate's reading, null when it was not evaluated. */
  readonly costToRisk: { readonly ratio: Ratio; readonly costPerShare: Fixed } | null;
  /** Position in the day's relative-volume ranking, 1 is the top. */
  readonly rank: number;
}

export const candidateSchema: z.ZodType<Candidate, z.ZodTypeDef, unknown> = z.object({
  symbol: z.string().min(1),
  session: sessionDateSchema,
  asOf: isoTimestampSchema,
  lastPrice: fixedSchema,
  averageDailyVolume: z.number().int().min(0),
  dailyAtr: fixedSchema,
  openingRvol: ratioSchema.nullable(),
  spreadBps: ratioSchema,
  costToRisk: z.object({ ratio: ratioSchema, costPerShare: fixedSchema }).nullable(),
  rank: z.number().int().positive(),
});
