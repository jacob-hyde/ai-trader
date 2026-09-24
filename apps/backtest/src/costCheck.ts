/**
 * The cost check: prices a sample of a run's trades from the market's own trades and quotes, and sets
 * what they would really have cost against what the cost model charged.
 *
 * It reads a finished per-signal run's confirmatory long trades. Each sampled signal's entry is priced
 * once and both exits on it (A and B share every entry). Legs are priced as fills.ts says: a stop at the
 * touch a moment after the print that triggers it, a market order at the touch when it is sent, a limit
 * at its limit. A trade still open at the bell keeps its modeled exit, since there is no quote to act on.
 *
 * It only measures data the in-sample run already spent. It tests nothing. What it gives a later study
 * is how far the model's costs sit from the market's, on these names at these moments.
 */

import { createRng } from "@trader/core";
import { LATENCY_MS, type Print, type Quote, firstThrough, marketFill } from "./fills.js";
import type { ExitReason, TradeRecord } from "./records.js";

export interface MarketTape {
  /** Prints for a symbol in [from, to), in time order. */
  prints(symbol: string, from: number, to: number): Promise<readonly Print[]>;
  /** The last usable quote at or before `at`, or null when there is none close enough. */
  quoteAt(symbol: string, at: number): Promise<Quote | null>;
}

export interface Signal {
  readonly symbol: string;
  readonly session: string;
  /** Session open, milliseconds since the epoch. */
  readonly openAt: number;
  /** The confirmatory trades on this signal, keyed by exit. */
  readonly trades: Readonly<Record<string, TradeRecord>>;
}

export type Unmeasured = "no trigger print" | "no quote";

export interface Leg {
  readonly modeled: number;
  /** Null when the leg could not be priced from the market. */
  readonly real: number | null;
  readonly why: Unmeasured | null;
  /** The quote the fill acted on, when there was one. */
  readonly quote: Quote | null;
}

export interface MeasuredTrade {
  readonly symbol: string;
  readonly session: string;
  /** Plan entry minus stop, dollars a share. */
  readonly risk: number;
  readonly trigger: number;
  readonly entry: Leg;
  readonly exits: Readonly<
    Record<
      string,
      {
        readonly reason: ExitReason;
        readonly leg: Leg;
        readonly modeledNetR: number;
        readonly grossR: number;
      }
    >
  >;
}

const dollars = (units: number | null) => (units === null ? 0 : units / 10_000);
const minuteStart = (openAt: number, minute: number) => openAt + minute * 60_000;

async function stopLeg(
  tape: MarketTape,
  symbol: string,
  from: number,
  level: number,
  direction: "up" | "down",
  modeled: number,
): Promise<Leg & { readonly at: number | null }> {
  const minute = Math.floor(from / 60_000) * 60_000;
  const prints = (await tape.prints(symbol, minute, minute + 60_000)).filter((p) => p.at >= from);
  const trigger = firstThrough(prints, level, direction);
  if (trigger === null) {
    return { modeled, real: null, why: "no trigger print", quote: null, at: null };
  }
  const at = trigger.at + LATENCY_MS;
  const quote = await tape.quoteAt(symbol, at);
  return quote === null
    ? { modeled, real: null, why: "no quote", quote: null, at }
    : { modeled, real: marketFill(direction === "up" ? "buy" : "sell", quote), why: null, quote, at };
}

/** Prices one signal's entry and every exit on it. Longs only, as the confirmatory test trades. */
export async function measureSignal(tape: MarketTape, signal: Signal): Promise<MeasuredTrade> {
  const any = Object.values(signal.trades)[0] as TradeRecord;
  const trigger = dollars(any.entry);
  const risk = trigger - dollars(any.stop);
  const entryAt = minuteStart(signal.openAt, any.entryMinute as number);
  const entry = await stopLeg(tape, signal.symbol, entryAt, trigger, "up", dollars(any.entryFill));
  const exits: Record<string, MeasuredTrade["exits"][string]> = {};
  for (const [exit, trade] of Object.entries(signal.trades)) {
    const reason = trade.exitReason as ExitReason;
    const modeled = dollars(trade.exitFill);
    const exitMinute = minuteStart(signal.openAt, trade.exitMinute as number);
    let leg: Leg;
    if (reason === "stop" || reason === "breakevenStop") {
      // A stop hit on the entry bar can only trigger after the entry filled.
      const level = reason === "stop" ? dollars(trade.stop) : trigger;
      leg = await stopLeg(
        tape,
        signal.symbol,
        Math.max(exitMinute, entry.at ?? exitMinute),
        level,
        "down",
        modeled,
      );
    } else if (reason === "target") {
      leg = { modeled, real: dollars(trade.target), why: null, quote: null };
    } else if (reason === "flatten") {
      const quote = await tape.quoteAt(signal.symbol, exitMinute + LATENCY_MS);
      leg =
        quote === null
          ? { modeled, real: null, why: "no quote", quote: null }
          : { modeled, real: marketFill("sell", quote), why: null, quote };
    } else {
      leg = { modeled, real: modeled, why: null, quote: null };
    }
    exits[exit] = {
      reason,
      leg,
      modeledNetR: (trade.netR as number) / 10_000,
      grossR: (trade.grossR as number) / 10_000,
    };
  }
  return { symbol: signal.symbol, session: signal.session, risk, trigger, entry, exits };
}

/**
 * Picks `perYear` signals from each calendar year, the same draw for the same seed and trades. A year
 * with fewer signals gives all of them.
 */
export function sampleSignals<T extends { readonly session: string; readonly symbol: string }>(
  signals: readonly T[],
  perYear: number,
  seed: number,
): T[] {
  const rng = createRng(seed);
  const years = new Map<string, T[]>();
  for (const s of [...signals].sort((a, b) =>
    `${a.session}${a.symbol}` < `${b.session}${b.symbol}` ? -1 : 1,
  )) {
    const year = s.session.slice(0, 4);
    (years.get(year) ?? years.set(year, []).get(year))?.push(s);
  }
  return [...years.keys()].sort().flatMap((year) => {
    const pool = [...(years.get(year) ?? [])];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = rng.int(0, i);
      [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
    }
    return pool.slice(0, perYear);
  });
}

export interface ExitSummary {
  readonly exit: string;
  /** Signals whose every leg on this exit was priced from the market. */
  readonly measured: number;
  readonly modeledNetR: number;
  readonly realNetR: number;
  readonly grossR: number;
  /** Mean cost per trade in R: gross less net. */
  readonly modeledCostR: number;
  readonly realCostR: number;
}

export interface CostSummary {
  readonly sampled: number;
  readonly unmeasured: Readonly<Record<string, number>>;
  /** Entry cost against the trigger, in basis points of the trigger: model, market. Means. */
  readonly entryCostBps: { readonly modeled: number; readonly real: number };
  /** Quoted spread at the entry, basis points of the midpoint: median, mean. */
  readonly entrySpreadBps: { readonly median: number; readonly mean: number };
  readonly exits: readonly ExitSummary[];
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export function summarize(measured: readonly MeasuredTrade[]): CostSummary {
  const unmeasured: Record<string, number> = {};
  const note = (why: string | null) => {
    if (why !== null) {
      unmeasured[why] = (unmeasured[why] ?? 0) + 1;
    }
  };
  measured.forEach((m) => {
    note(m.entry.why === null ? null : `entry: ${m.entry.why}`);
    Object.entries(m.exits).forEach(([exit, e]) =>
      note(e.leg.why === null ? null : `exit ${exit} ${e.reason}: ${e.leg.why}`),
    );
  });
  const entered = measured.filter((m) => m.entry.real !== null);
  const spreads = entered
    .map((m) => m.entry.quote as Quote)
    .map((q) => ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10_000)
    .sort((a, b) => a - b);
  const exitIds = [...new Set(measured.flatMap((m) => Object.keys(m.exits)))].sort();
  return {
    sampled: measured.length,
    unmeasured,
    entryCostBps: {
      modeled: mean(entered.map((m) => ((m.entry.modeled - m.trigger) / m.trigger) * 10_000)),
      real: mean(entered.map((m) => (((m.entry.real as number) - m.trigger) / m.trigger) * 10_000)),
    },
    entrySpreadBps: { median: spreads[Math.floor(spreads.length / 2)] ?? 0, mean: mean(spreads) },
    exits: exitIds.map((exit) => {
      const both = entered.filter((m) => m.exits[exit]?.leg.real != null);
      const real = both.map((m) => {
        const e = m.exits[exit] as MeasuredTrade["exits"][string];
        return ((e.leg.real as number) - (m.entry.real as number)) / m.risk;
      });
      const modeled = both.map((m) => (m.exits[exit] as MeasuredTrade["exits"][string]).modeledNetR);
      const gross = both.map((m) => (m.exits[exit] as MeasuredTrade["exits"][string]).grossR);
      return {
        exit,
        measured: both.length,
        modeledNetR: mean(modeled),
        realNetR: mean(real),
        grossR: mean(gross),
        modeledCostR: mean(gross) - mean(modeled),
        realCostR: mean(gross) - mean(real),
      };
    }),
  };
}

export interface CostCheckSettings {
  readonly runId: string;
  readonly perYear: number;
  readonly seed: number;
  readonly latencyMs: number;
}

const r = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(4)}R`;

/** The cost check as markdown. */
export function renderCostReport(settings: CostCheckSettings, summary: CostSummary): string {
  const unmeasured = Object.entries(summary.unmeasured);
  return [
    "# Cost check: modeled fills against the market",
    "",
    `Run ${settings.runId}: ${String(summary.sampled)} confirmatory long signals, ${String(settings.perYear)} a year drawn with seed ${String(settings.seed)}, priced from SIP trades and quotes. A stop fills at the touch ${String(settings.latencyMs)} ms after the print that triggers it, a flatten at the touch ${String(settings.latencyMs)} ms into its minute, a target at its limit.`,
    "",
    `Entry cost against the trigger: modeled ${summary.entryCostBps.modeled.toFixed(1)} bps, market ${summary.entryCostBps.real.toFixed(1)} bps. Quoted spread at the entry: median ${summary.entrySpreadBps.median.toFixed(1)} bps, mean ${summary.entrySpreadBps.mean.toFixed(1)} bps.`,
    "",
    "| Exit | Priced | Gross | Net, modeled | Net, market | Cost, modeled | Cost, market |",
    "|---|---|---|---|---|---|---|",
    ...summary.exits.map(
      (e) =>
        `| ${e.exit} | ${String(e.measured)} | ${r(e.grossR)} | ${r(e.modeledNetR)} | ${r(e.realNetR)} | ${r(e.modeledCostR)} | ${r(e.realCostR)} |`,
    ),
    "",
    unmeasured.length === 0
      ? "Every leg was priced from the market."
      : `Not priced: ${unmeasured.map(([why, n]) => `${why} ${String(n)}`).join("; ")}.`,
    "",
  ].join("\n");
}
