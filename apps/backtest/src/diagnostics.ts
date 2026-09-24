/**
 * Section 7's diagnostics, from the per-signal run's records. None of them gates the verdict.
 *
 * How each is taken is Amendment 6's: which records each one reads, analytic day-clustered intervals
 * (the bootstrap decides the verdict alone), cost sensitivity and the break-even stop-entry allowance by
 * pricing the same trades' fills again (recost.ts), and nothing about costs reported unless that pricing
 * first reproduces every recorded fill.
 */

import type { Fixed } from "@trader/contracts";
import { type CostModelConfig, quoteFromReference, slippagePerShare } from "@trader/core";
import { clusteredMean } from "./metrics.js";
import { ATR_DIAGNOSTIC_FRACTIONS, atrVariantId } from "./preregistered.js";
import type { TradeRecord } from "./records.js";
import { reprice } from "./recost.js";

export interface Estimate {
  readonly trades: number;
  /** In R, null with no trades. */
  readonly meanR: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
}

export interface BreakEven {
  readonly exit: string;
  /**
   * Basis points of the touch at which mean net R reaches zero. Null when it is at or below zero even
   * with a free stop entry.
   */
  readonly stopEntryBps: number | null;
  /** True when mean net R is still positive at the search's ceiling, which stopEntryBps then holds. */
  readonly aboveCeiling: boolean;
  /** The modeled stop-entry allowance, on average over the same trades, in basis points of the touch. */
  readonly modeledBps: number | null;
}

export interface Diagnostics {
  /** H3: range-low longs the gate passed against those it rejected, per exit. */
  readonly gate: readonly { readonly exit: string; readonly passed: Estimate; readonly rejected: Estimate }[];
  /** H4: the published 10% ATR stop, longs, the gate off. */
  readonly publishedStop: readonly {
    readonly exit: string;
    readonly variant: string;
    readonly signals: number;
    readonly gatePassed: number;
    readonly estimate: Estimate;
  }[];
  /** The 50% ATR stop, longs, the gate on. */
  readonly atr50: readonly { readonly exit: string; readonly variant: string; readonly estimate: Estimate }[];
  /** H5: the confirmatory trades by opening-RVOL rank. */
  readonly rvolBuckets: readonly {
    readonly exit: string;
    readonly buckets: readonly { readonly from: number; readonly to: number; readonly estimate: Estimate }[];
  }[];
  /** The bearish range, range-low stop, the gate on. */
  readonly shorts: readonly { readonly exit: string; readonly estimate: Estimate }[];
  readonly costs: {
    /** Trades whose recorded fills the repricing reproduced. */
    readonly checked: number;
    /** The first trade it did not reproduce, if any. Then nothing below is reported. */
    readonly mismatch: string | null;
    readonly sensitivity: readonly {
      readonly exit: string;
      readonly rows: readonly { readonly scale: number; readonly estimate: Estimate }[];
    }[];
    readonly breakEven: readonly BreakEven[];
  };
}

export interface DiagnosticsSettings {
  /** The confirmatory exits' variant ids, in section 11's order. */
  readonly exits: readonly string[];
  readonly costScales: readonly number[];
  readonly rvolBuckets: readonly (readonly [number, number])[];
  readonly breakEvenMaxBps: number;
}

const filled = (t: TradeRecord) => t.entryOutcome === "filled" && t.netR !== null;

/** Mean net R with its analytic day-clustered 95% interval. */
export function estimate(
  trades: readonly TradeRecord[],
  netR = (t: TradeRecord) => t.netR as number,
): Estimate {
  const byDay = new Map<string, number[]>();
  for (const t of trades) {
    (byDay.get(t.session) ?? byDay.set(t.session, []).get(t.session))?.push(netR(t) / 10_000);
  }
  const m = clusteredMean(byDay);
  return { trades: trades.length, meanR: m?.mean ?? null, lower: m?.lower ?? null, upper: m?.upper ?? null };
}

/** The trades that count for a variant and direction: filled, and passed by the gate unless it is off. */
export function select(
  records: readonly TradeRecord[],
  variant: string,
  direction: "long" | "short",
  gate: "on" | "off" = "on",
): TradeRecord[] {
  return records.filter(
    (t) =>
      t.variant === variant && t.direction === direction && filled(t) && (gate === "off" || t.gatePassed),
  );
}

function breakEven(
  exit: string,
  trades: readonly TradeRecord[],
  model: CostModelConfig,
  ceiling: number,
): BreakEven {
  if (trades.length === 0) {
    return { exit, stopEntryBps: null, aboveCeiling: false, modeledBps: null };
  }
  const meanAt = (bps: number) =>
    trades.reduce((total, t) => total + reprice(t, model, { stopEntryBps: bps }).netR, 0) / trades.length;
  const modeledBps =
    trades.reduce((total, t) => {
      const quote = quoteFromReference(t.entryReference as Fixed, model.spread);
      const touch = t.direction === "long" ? quote.ask : quote.bid;
      return total + (slippagePerShare(touch, model.slippage.stopEntry) / touch) * 10_000;
    }, 0) / trades.length;
  if (meanAt(0) <= 0) {
    return { exit, stopEntryBps: null, aboveCeiling: false, modeledBps };
  }
  if (meanAt(ceiling) > 0) {
    return { exit, stopEntryBps: ceiling, aboveCeiling: true, modeledBps };
  }
  let [low, high] = [0, ceiling];
  while (high - low > 0.01) {
    const mid = (low + high) / 2;
    if (meanAt(mid) > 0) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return { exit, stopEntryBps: Math.round(((low + high) / 2) * 100) / 100, aboveCeiling: false, modeledBps };
}

export function diagnostics(
  records: readonly TradeRecord[],
  model: CostModelConfig,
  settings: DiagnosticsSettings,
): Diagnostics {
  const confirmatory = new Map(settings.exits.map((exit) => [exit, select(records, exit, "long")]));
  const [published, wide] = ATR_DIAGNOSTIC_FRACTIONS;

  // The repricing must give back every recorded fill before a cost figure means anything.
  const priced = [...confirmatory.values()].flat();
  let mismatch: string | null = null;
  for (const t of priced) {
    const again = reprice(t, model);
    if (again.entryFill !== t.entryFill || again.exitFill !== t.exitFill || again.netR !== t.netR) {
      mismatch = `${t.variant} ${t.symbol} ${t.session}: recorded ${String(t.entryFill)}/${String(t.exitFill)}/${String(t.netR)}, repriced ${String(again.entryFill)}/${String(again.exitFill)}/${String(again.netR)}`;
      break;
    }
  }

  return {
    gate: settings.exits.map((exit) => ({
      exit,
      passed: estimate(confirmatory.get(exit) ?? []),
      rejected: estimate(
        records.filter((t) => t.variant === exit && t.direction === "long" && filled(t) && !t.gatePassed),
      ),
    })),
    publishedStop: settings.exits.map((exit) => {
      const variant = atrVariantId(published, exit);
      const signals = records.filter((t) => t.variant === variant && t.direction === "long");
      return {
        exit,
        variant,
        signals: signals.length,
        gatePassed: signals.filter((t) => t.gatePassed).length,
        estimate: estimate(select(records, variant, "long", "off")),
      };
    }),
    atr50: settings.exits.map((exit) => {
      const variant = atrVariantId(wide, exit);
      return { exit, variant, estimate: estimate(select(records, variant, "long")) };
    }),
    rvolBuckets: settings.exits.map((exit) => ({
      exit,
      buckets: settings.rvolBuckets.map(([from, to]) => ({
        from,
        to,
        estimate: estimate((confirmatory.get(exit) ?? []).filter((t) => t.rank >= from && t.rank <= to)),
      })),
    })),
    shorts: settings.exits.map((exit) => ({ exit, estimate: estimate(select(records, exit, "short")) })),
    costs: {
      checked: mismatch === null ? priced.length : 0,
      mismatch,
      sensitivity:
        mismatch !== null
          ? []
          : settings.exits.map((exit) => {
              const trades = confirmatory.get(exit) ?? [];
              return {
                exit,
                rows: [1, ...settings.costScales]
                  .sort((a, b) => a - b)
                  .map((scale) => ({
                    scale,
                    estimate: estimate(trades, (t) => reprice(t, model, { slippageScale: scale }).netR),
                  })),
              };
            }),
      breakEven:
        mismatch !== null
          ? []
          : settings.exits.map((exit) =>
              breakEven(exit, confirmatory.get(exit) ?? [], model, settings.breakEvenMaxBps),
            ),
    },
  };
}
