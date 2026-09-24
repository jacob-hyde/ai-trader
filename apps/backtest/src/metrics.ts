/**
 * A run's results metrics (L.4), from its persisted trades.
 *
 * Computed per variant and direction over the trades that count: filled, and passed by the cost gate.
 * R is net R per trade against the plan's stop; dollars are net P&L. Everything reads the same trade
 * list, so a metric cannot disagree with another about which trades there were.
 *
 * Expectancy carries a day-clustered 95% interval: trades on one day share the market, so the day is
 * the unit of independence (Pre-Registration section 5). The interval here is the analytic cluster
 * interval, for reading a run at a glance. The verdict uses the pre-registered bootstrap (L.2), not this.
 *
 * Equity is closed-trade equity, in exit order: a drawdown is measured from the highest equity any exit
 * reached to the lowest after it. Per signal, equity is in R, since every signal is its own trade. As
 * deployed, it is also in dollars on the account's starting cash, and the daily Sharpe and Sortino are on
 * the account's daily returns; per signal they are on the day's total R.
 *
 * Daily ratios count every session of the run, a day with no trade as zero, and annualize by the square
 * root of 252.
 */

import type { Fixed, Ratio } from "@trader/contracts";

export interface MetricTrade {
  readonly session: string;
  readonly symbol: string;
  readonly entryMinute: number;
  readonly exitMinute: number;
  /** Basis points of R. */
  readonly netR: Ratio;
  /** $0.0001 units. */
  readonly netPnl: Fixed;
}

export interface Interval {
  readonly mean: number;
  readonly lower: number;
  readonly upper: number;
}

export interface DistributionBucket {
  /** Exclusive lower edge in R, null for the lowest bucket. */
  readonly above: number | null;
  /** Inclusive upper edge in R, null for the highest bucket. */
  readonly upTo: number | null;
  readonly count: number;
}

export interface YearMetrics {
  readonly year: number;
  readonly trades: number;
  readonly winRate: number;
  readonly meanR: number;
  readonly totalR: number;
}

export interface Metrics {
  readonly trades: number;
  /** Sessions of the run, traded or not. */
  readonly sessions: number;
  /** Share of trades with net R above zero. Null with no trades. */
  readonly winRate: number | null;
  /** Mean net R with its day-clustered 95% interval. */
  readonly expectancyR: Interval | null;
  readonly expectancyDollars: Interval | null;
  /** Gross profit over gross loss, in R. Null when there is no loss to divide by. */
  readonly profitFactor: number | null;
  readonly totalR: number;
  readonly totalDollars: number;
  readonly distribution: {
    readonly min: number;
    readonly p5: number;
    readonly p25: number;
    readonly median: number;
    readonly p75: number;
    readonly p95: number;
    readonly max: number;
    readonly buckets: readonly DistributionBucket[];
  } | null;
  readonly equity: {
    /** Closed-trade equity in R at the end of each session. */
    readonly dailyR: readonly { readonly session: string; readonly r: number }[];
    readonly maxDrawdownR: number;
    /** As deployed only: dollars on the starting cash, end of each session. */
    readonly dailyDollars: readonly { readonly session: string; readonly equity: number }[] | null;
    readonly maxDrawdownDollars: number;
    /** As deployed only: the largest drawdown as a share of the peak it fell from. */
    readonly maxDrawdownPct: number | null;
  };
  /** Annualized. Null when the daily series has no spread (or no downside, for Sortino). */
  readonly sharpe: number | null;
  readonly sortino: number | null;
  readonly exposure: {
    readonly meanHoldMinutes: number | null;
    /** Most positions open in any one minute. */
    readonly peakConcurrent: number;
    /** Position-minutes a session, on average over every session. */
    readonly positionMinutesPerSession: number;
  };
  readonly byYear: readonly YearMetrics[];
}

/** Edges of the R distribution's buckets. */
export const R_BUCKET_EDGES = [-1.5, -1, -0.5, 0, 0.5, 1, 2, 3, 5] as const;

const Z_95 = 1.96;
const TRADING_DAYS = 252;

const toR = (bps: number) => bps / 10_000;
const toDollars = (units: number) => units / 10_000;
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** Nearest rank: the smallest value with at least p of the sample at or below it. */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] as number;
}

/**
 * Mean of per-trade values with a day-clustered 95% interval: the ratio estimator's cluster-robust
 * variance, sum over days of (day total minus day count times the mean) squared, over trades squared,
 * with the G/(G-1) small-sample factor. Under two days there is no spread to measure.
 */
export function clusteredMean(byDay: ReadonlyMap<string, readonly number[]>): Interval | null {
  const days = [...byDay.values()].filter((values) => values.length > 0);
  const n = sum(days.map((values) => values.length));
  if (n === 0) {
    return null;
  }
  const mean = sum(days.map(sum)) / n;
  if (days.length < 2) {
    return { mean, lower: mean, upper: mean };
  }
  const g = days.length;
  const variance =
    (sum(days.map((values) => (sum(values) - values.length * mean) ** 2)) / n ** 2) * (g / (g - 1));
  const half = Z_95 * Math.sqrt(variance);
  return { mean, lower: mean - half, upper: mean + half };
}

/** Largest fall from a running peak. The peak starts at `start`, so an opening loss counts. */
function maxDrawdown(path: readonly number[], start: number): { amount: number; pct: number | null } {
  let peak = start;
  let amount = 0;
  let pct: number | null = null;
  for (const value of path) {
    peak = Math.max(peak, value);
    if (peak - value > amount) {
      amount = peak - value;
      pct = peak > 0 ? amount / peak : null;
    }
  }
  return { amount, pct };
}

function annualized(daily: readonly number[]): { sharpe: number | null; sortino: number | null } {
  if (daily.length < 2) {
    return { sharpe: null, sortino: null };
  }
  const mean = sum(daily) / daily.length;
  const sd = Math.sqrt(sum(daily.map((x) => (x - mean) ** 2)) / (daily.length - 1));
  const downside = Math.sqrt(sum(daily.map((x) => Math.min(x, 0) ** 2)) / daily.length);
  const root = Math.sqrt(TRADING_DAYS);
  return {
    sharpe: sd === 0 ? null : (mean / sd) * root,
    sortino: downside === 0 ? null : (mean / downside) * root,
  };
}

function buckets(values: readonly number[]): DistributionBucket[] {
  const edges = [null, ...R_BUCKET_EDGES, null];
  return edges.slice(0, -1).map((above, i) => {
    const upTo = edges[i + 1] ?? null;
    return {
      above,
      upTo,
      count: values.filter((v) => (above === null || v > above) && (upTo === null || v <= upTo)).length,
    };
  });
}

/**
 * Metrics over one variant's trades.
 *
 * `sessions` is every session the run replayed, in order. `startingCash` is the as-deployed account's,
 * in $0.0001 units, or null for a per-signal run.
 */
export function computeMetrics(
  trades: readonly MetricTrade[],
  sessions: readonly string[],
  startingCash: Fixed | null,
): Metrics {
  const ordered = [...trades].sort((a, b) =>
    a.session !== b.session
      ? a.session < b.session
        ? -1
        : 1
      : a.exitMinute !== b.exitMinute
        ? a.exitMinute - b.exitMinute
        : a.symbol < b.symbol
          ? -1
          : 1,
  );
  const r = ordered.map((t) => toR(t.netR));
  const dollars = ordered.map((t) => toDollars(t.netPnl));
  const byDay = <T>(pick: (t: MetricTrade) => T) => {
    const days = new Map<string, T[]>();
    for (const t of ordered) {
      (days.get(t.session) ?? days.set(t.session, []).get(t.session))?.push(pick(t));
    }
    return days;
  };
  const rByDay = byDay((t) => toR(t.netR));
  const dollarsByDay = byDay((t) => toDollars(t.netPnl));

  const wins = r.filter((v) => v > 0);
  const losses = r.filter((v) => v < 0);
  const sorted = [...r].sort((a, b) => a - b);

  // Closed-trade equity in exit order, and at each session's end.
  const cumulative = (values: readonly number[], start: number) => {
    let running = start;
    return values.map((v) => (running += v));
  };
  const pathR = cumulative(r, 0);
  const cash = startingCash === null ? null : toDollars(startingCash);
  const pathDollars = cumulative(dollars, cash ?? 0);
  const endOfDay = (path: readonly number[], start: number) => {
    let at = 0;
    let value = start;
    return sessions.map((session) => {
      while (at < ordered.length && (ordered[at] as MetricTrade).session <= session) {
        value = path[at] as number;
        at += 1;
      }
      return { session, value };
    });
  };
  const drawdownR = maxDrawdown(pathR, 0);
  const drawdownDollars = maxDrawdown(pathDollars, cash ?? 0);

  // Daily series over every session: total R, or the account's return on the day's opening equity.
  let equityAtOpen = cash ?? 0;
  const daily = sessions.map((session) => {
    if (cash === null) {
      return sum(rByDay.get(session) ?? []);
    }
    const pnl = sum(dollarsByDay.get(session) ?? []);
    const dayReturn = equityAtOpen === 0 ? 0 : pnl / equityAtOpen;
    equityAtOpen += pnl;
    return dayReturn;
  });

  // Exposure: a trade holds from its entry minute to its exit minute, and at least the one minute.
  const holds = ordered.map((t) => Math.max(1, t.exitMinute - t.entryMinute));
  let peakConcurrent = 0;
  for (const dayTrades of byDay((t) => t).values()) {
    const open = new Map<number, number>();
    for (const t of dayTrades) {
      for (let m = t.entryMinute; m < Math.max(t.entryMinute + 1, t.exitMinute); m += 1) {
        open.set(m, (open.get(m) ?? 0) + 1);
      }
    }
    peakConcurrent = Math.max(peakConcurrent, ...open.values());
  }

  const years = new Map<number, number[]>();
  for (const t of ordered) {
    const year = Number(t.session.slice(0, 4));
    (years.get(year) ?? years.set(year, []).get(year))?.push(toR(t.netR));
  }

  return {
    trades: ordered.length,
    sessions: sessions.length,
    winRate: r.length === 0 ? null : wins.length / r.length,
    expectancyR: clusteredMean(rByDay),
    expectancyDollars: clusteredMean(dollarsByDay),
    profitFactor: losses.length === 0 ? null : sum(wins) / -sum(losses),
    totalR: sum(r),
    totalDollars: sum(dollars),
    distribution:
      sorted.length === 0
        ? null
        : {
            min: sorted[0] as number,
            p5: percentile(sorted, 0.05),
            p25: percentile(sorted, 0.25),
            median: percentile(sorted, 0.5),
            p75: percentile(sorted, 0.75),
            p95: percentile(sorted, 0.95),
            max: sorted.at(-1) as number,
            buckets: buckets(r),
          },
    equity: {
      dailyR: endOfDay(pathR, 0).map(({ session, value }) => ({ session, r: value })),
      maxDrawdownR: drawdownR.amount,
      dailyDollars:
        cash === null
          ? null
          : endOfDay(pathDollars, cash).map(({ session, value }) => ({ session, equity: value })),
      maxDrawdownDollars: drawdownDollars.amount,
      maxDrawdownPct: cash === null ? null : (drawdownDollars.pct ?? 0),
    },
    ...annualized(daily),
    exposure: {
      meanHoldMinutes: holds.length === 0 ? null : sum(holds) / holds.length,
      peakConcurrent,
      positionMinutesPerSession: sessions.length === 0 ? 0 : sum(holds) / sessions.length,
    },
    byYear: [...years]
      .sort(([a], [b]) => a - b)
      .map(([year, values]) => ({
        year,
        trades: values.length,
        winRate: values.filter((v) => v > 0).length / values.length,
        meanR: sum(values) / values.length,
        totalR: sum(values),
      })),
  };
}
