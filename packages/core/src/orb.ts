/**
 * High relative-volume opening range breakout, after Zarattini, Barbon and Aziz (SSRN 4729284).
 *
 * The opening range is the first five minutes of the session. A bullish range goes long with a stop
 * entry at the range high, a bearish one mirrors it short at the range low, and a doji does nothing.
 * The published stop is 10% of the 14-day ATR from entry and there is no target: the position runs to
 * the EOD flatten.
 *
 * DO NOT "FIX" THE WIN RATE. The published profile wins about 17% of the time. Almost every trade is a
 * small loss at the tight stop, and the expectancy comes from a fat right tail of trades that run all
 * day. Widening the stop, adding a target, or filtering for a higher hit rate changes what is being
 * measured. Those are variants to test on purpose, selected by config, never quiet improvements.
 *
 * The edge lives in the relative-volume gate, not in the breakout: about +0.08R per trade above 100%
 * opening RVOL and about -0.02R below it. So the gate is enforced here as well as upstream, in both
 * evaluateContext and detectTrigger, and a name that fails it can never produce a signal.
 *
 * Variants, each selected by config for the A/B. Stop: a fraction of the daily ATR (0.1 is the
 * published one, 0.5 a wider one) or the far side of the opening range. Exit: EOD, or a fixed R target
 * with an optional move to breakeven. Trailing is not implemented. Nothing specifies it and it is not
 * part of the A/B.
 *
 * No look-ahead. A signal needs proof the range has closed, which is a closed bar at or past its last
 * minute, and it reads only the bars it is handed. The daily ATR must come from completed sessions
 * only. That is the caller's job.
 *
 * A signal is also refused once price has already traded through the entry after the range closed. A
 * stop entry placed then would fill at market, far from the level, which is chasing and not the setup.
 * Same bars in, same signal out, so asking again later yields the identical signal and order id.
 *
 * Expects one-minute bars. Stage 3 owns the price band, average volume, top-N ranking, and the
 * cost-to-risk gate.
 */

import { z } from "zod";
import type { Bar } from "./bars.js";
import {
  type Fixed,
  type Ratio,
  add,
  fromNumber,
  max,
  min,
  mulRatio,
  ratio,
  roundToTick,
  sub,
  tickSize,
} from "./money.js";
import type {
  ContextVerdict,
  PositionManagement,
  SetupDefinition,
  SetupSignal,
  SymbolState,
} from "./setup.js";
import { SetupError } from "./setup.js";
import type { Direction } from "./sizing.js";

export const ORB_ID = "orb";
export const ORB_VERSION = "1.0.0";

/** A plain multiple, e.g. 0.1 or 1.5, held as whole basis points. */
const multiple = (lower: number, upper: number) =>
  z
    .number()
    .min(lower)
    .max(upper)
    .transform((value): Ratio => ratio(Math.round(value * 10_000)));

const stopSchema = z.discriminatedUnion("kind", [
  // Stop sits this fraction of the daily ATR from entry. 0.1 is the published stop.
  z.object({ kind: z.literal("atrFraction"), fraction: multiple(0.01, 1) }).strict(),
  // Stop sits at the far side of the opening range: its low for a long, its high for a short.
  z.object({ kind: z.literal("openingRange") }).strict(),
]);

const exitSchema = z
  .discriminatedUnion("kind", [
    // No target. The position runs to the EOD flatten. The published exit.
    z.object({ kind: z.literal("eod") }).strict(),
    z
      .object({
        kind: z.literal("fixedR"),
        targetR: multiple(0.5, 10),
        breakevenAtR: multiple(0.25, 10).nullable().default(null),
      })
      .strict(),
  ])
  .refine((exit) => exit.kind === "eod" || exit.breakevenAtR === null || exit.breakevenAtR < exit.targetR, {
    message: "breakevenAtR must be below targetR",
  });

/**
 * Every ORB parameter, bounded. The defaults are the published strategy.
 *
 * entryWindowMinutes and lastEntryMinute are ours, not the paper's, which leaves the entry working all
 * day. Pre-registration fixes them before any backtest number exists.
 */
export const orbParamsSchema = z.object({
  /** Length of the opening range in minutes. */
  openingRangeMinutes: z.number().int().min(1).max(30).default(5),
  /** Opening relative volume must exceed this multiple. 1 is 100%. */
  minOpeningRvol: multiple(0, 100).default(1),
  /** The daily ATR, in dollars, must exceed this. */
  minDailyAtr: z
    .number()
    .min(0)
    .max(100)
    .transform((dollars): Fixed => fromNumber(dollars))
    .default(0.5),
  /** Emit short signals on a bearish range. Off in v1, and the engine has its own flag as well. */
  allowShort: z.boolean().default(false),
  stop: stopSchema.default({ kind: "atrFraction", fraction: 0.1 }),
  exit: exitSchema.default({ kind: "eod" }),
  /**
   * Minutes after the range closes that an unfilled entry may keep working while price sits back
   * inside the range. Null never cancels on this rule.
   */
  entryWindowMinutes: z.number().int().min(1).max(390).nullable().default(null),
  /** Minute of the session at which no entry may start or keep working. 360 is 15:30 ET. */
  lastEntryMinute: z.number().int().min(1).max(390).default(360),
});

export type OrbParams = z.infer<typeof orbParamsSchema>;

/** Stable reason codes from evaluateContext. */
export type OrbContextReason =
  | "ORB_RVOL_NOT_WARM"
  | "ORB_RVOL_BELOW_MIN"
  | "ORB_ATR_NOT_WARM"
  | "ORB_ATR_BELOW_MIN"
  | "ORB_RANGE_NOT_CLOSED"
  | "ORB_SESSION_GATE_CLOSED";

interface OpeningRange {
  readonly open: Fixed;
  readonly high: Fixed;
  readonly low: Fixed;
  readonly close: Fixed;
  /** Minute of the first bar at or past the range's last minute: the proof it closed. */
  readonly closedAtMinute: number;
  /** Bars after the range, oldest first. */
  readonly after: readonly Bar[];
}

/** The symbol-level gate, shared so detectTrigger can never signal what evaluateContext refuses. */
function gateReasons(symbol: SymbolState, params: OrbParams): OrbContextReason[] {
  const reasons: OrbContextReason[] = [];
  if (symbol.openingRvol === null) {
    reasons.push("ORB_RVOL_NOT_WARM");
  } else if (symbol.openingRvol <= params.minOpeningRvol) {
    reasons.push("ORB_RVOL_BELOW_MIN");
  }
  if (symbol.dailyAtr === null) {
    reasons.push("ORB_ATR_NOT_WARM");
  } else if (symbol.dailyAtr <= params.minDailyAtr) {
    reasons.push("ORB_ATR_BELOW_MIN");
  }
  return reasons;
}

function openingRange(bars: readonly Bar[], session: string, minutes: number): OpeningRange | null {
  const today = bars.filter((bar) => bar.session === session);
  const inside = today.filter((bar) => bar.minuteOfSession < minutes);
  const closer = today.find((bar) => bar.minuteOfSession >= minutes - 1);
  const first = inside[0];
  const last = inside.at(-1);
  if (first === undefined || last === undefined || closer === undefined) {
    return null;
  }
  return {
    open: first.open,
    high: inside.map((bar) => bar.high).reduce(max),
    low: inside.map((bar) => bar.low).reduce(min),
    close: last.close,
    closedAtMinute: closer.minuteOfSession,
    after: today.filter((bar) => bar.minuteOfSession >= minutes),
  };
}

/** The ATR distance is at least one tick, so a tiny ATR can never round the stop onto entry. */
function stopFor(signal: SetupSignal, symbol: SymbolState, params: OrbParams): Fixed {
  const { entry, direction, levels } = signal;
  if (params.stop.kind === "openingRange") {
    const farSide = direction === "long" ? levels["rangeLow"] : levels["rangeHigh"];
    if (farSide === undefined) {
      throw new SetupError("CONTRACT_VIOLATION", "ORB stop needs the range levels of its own signal");
    }
    return roundToTick(farSide, "nearest");
  }
  if (symbol.dailyAtr === null) {
    throw new SetupError("CONTRACT_VIOLATION", "ORB stop needs a warm daily ATR");
  }
  const distance = max(mulRatio(symbol.dailyAtr, params.stop.fraction, "nearest"), tickSize(entry));
  return roundToTick(direction === "long" ? sub(entry, distance) : add(entry, distance), "nearest");
}

function targetFor(signal: SetupSignal, stop: Fixed, params: OrbParams): Fixed | null {
  if (params.exit.kind === "eod") {
    return null;
  }
  const { entry, direction } = signal;
  const risk = direction === "long" ? sub(entry, stop) : sub(stop, entry);
  const reward = mulRatio(risk, params.exit.targetR, "nearest");
  return roundToTick(direction === "long" ? add(entry, reward) : sub(entry, reward), "nearest");
}

export const orbSetupDefinition: SetupDefinition<typeof orbParamsSchema> = {
  id: ORB_ID,
  version: ORB_VERSION,
  directions: ["long", "short"],
  // 14 daily bars for the ATR, 14 sessions for the relative-volume baseline, and the range itself.
  warmup: { dailyBars: 14, sessions: 14, sessionBars: 5 },
  paramsSchema: orbParamsSchema,
  create: (params) => ({
    evaluateContext(symbol, market): ContextVerdict {
      const reasons = gateReasons(symbol, params);
      if (symbol.minuteOfSession < params.openingRangeMinutes - 1) {
        reasons.push("ORB_RANGE_NOT_CLOSED");
      }
      if (market.minuteOfSession >= Math.min(params.lastEntryMinute, market.closeMinute)) {
        reasons.push("ORB_SESSION_GATE_CLOSED");
      }
      return reasons.length === 0 ? { applies: true } : { applies: false, reasons };
    },

    detectTrigger(symbol, bars): SetupSignal | null {
      if (gateReasons(symbol, params).length > 0) {
        return null;
      }
      const range = openingRange(bars, symbol.session, params.openingRangeMinutes);
      if (range === null || range.close === range.open) {
        return null;
      }
      const direction: Direction = range.close > range.open ? "long" : "short";
      if (direction === "short" && !params.allowShort) {
        return null;
      }
      const entry = roundToTick(direction === "long" ? range.high : range.low, "nearest");
      const alreadyThrough = range.after.some((bar) =>
        direction === "long" ? bar.high >= entry : bar.low <= entry,
      );
      if (alreadyThrough) {
        return null;
      }
      return {
        setupId: ORB_ID,
        setupVersion: ORB_VERSION,
        symbol: symbol.symbol,
        direction,
        session: symbol.session,
        minuteOfSession: range.closedAtMinute,
        entryType: "stop",
        entry,
        levels: {
          rangeOpen: range.open,
          rangeHigh: range.high,
          rangeLow: range.low,
          rangeClose: range.close,
        },
      };
    },

    stop: (signal, symbol) => stopFor(signal, symbol, params),

    target: (signal, symbol) => targetFor(signal, stopFor(signal, symbol, params), params),

    invalidation(signal, symbol): boolean {
      if (symbol.session !== signal.session || symbol.minuteOfSession >= params.lastEntryMinute) {
        return true;
      }
      if (params.entryWindowMinutes === null) {
        return false;
      }
      const windowOver = symbol.minuteOfSession >= params.openingRangeMinutes + params.entryWindowMinutes;
      const backInside =
        signal.direction === "long" ? symbol.lastClose < signal.entry : symbol.lastClose > signal.entry;
      return windowOver && backInside;
    },

    management(): PositionManagement {
      return { breakevenAtR: params.exit.kind === "fixedR" ? params.exit.breakevenAtR : null };
    },
  }),
};
