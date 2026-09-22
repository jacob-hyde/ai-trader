/**
 * The engine's heartbeat, as published to Redis for the app. Everything the health panel shows.
 */

import { z } from "zod";
import { type Fixed, fixedSchema } from "./money.js";
import { RUN_MODES, type RunMode } from "./runMode.js";
import { type IsoTimestamp, isoTimestampSchema } from "./time.js";

export interface EngineHealth {
  readonly mode: RunMode;
  readonly engineVersion: string;
  readonly at: IsoTimestamp;
  /** Climbs by one per heartbeat. A gap means a missed beat. */
  readonly heartbeatSeq: number;
  /** True once the panic endpoint or a stall has halted new entries. */
  readonly halted: boolean;
  readonly dataFeed: {
    readonly connected: boolean;
    readonly lastBarAt: IsoTimestamp | null;
    readonly lastQuoteAt: IsoTimestamp | null;
    readonly subscriptions: number;
  };
  readonly broker: {
    readonly connected: boolean;
    readonly lastSyncAt: IsoTimestamp | null;
    /** Remaining requests before the rate limit, null when the broker does not say. */
    readonly rateLimitRemaining: number | null;
  };
  readonly breaker: {
    readonly tripped: boolean;
    readonly dayPnl: Fixed;
    readonly dailyLossLimit: Fixed;
  };
  readonly equity: Fixed;
  readonly startOfDayEquity: Fixed;
  readonly openPositions: number;
  readonly workingOrders: number;
}

export const engineHealthSchema: z.ZodType<EngineHealth, z.ZodTypeDef, unknown> = z.object({
  mode: z.enum(RUN_MODES),
  engineVersion: z.string().min(1),
  at: isoTimestampSchema,
  heartbeatSeq: z.number().int().min(0),
  halted: z.boolean(),
  dataFeed: z.object({
    connected: z.boolean(),
    lastBarAt: isoTimestampSchema.nullable(),
    lastQuoteAt: isoTimestampSchema.nullable(),
    subscriptions: z.number().int().min(0),
  }),
  broker: z.object({
    connected: z.boolean(),
    lastSyncAt: isoTimestampSchema.nullable(),
    rateLimitRemaining: z.number().int().min(0).nullable(),
  }),
  breaker: z.object({
    tripped: z.boolean(),
    dayPnl: fixedSchema,
    dailyLossLimit: fixedSchema,
  }),
  equity: fixedSchema,
  startOfDayEquity: fixedSchema,
  openPositions: z.number().int().min(0),
  workingOrders: z.number().int().min(0),
});
