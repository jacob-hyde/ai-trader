import { describe, expect, it } from "vitest";
import type { SessionHours, StoredBar } from "@trader/adapters";
import type { SymbolBar } from "@trader/contracts";
import { MemoryStudySource } from "./memory.js";
import { dailyBar, px, quietMinutes, testConfig, weekdays } from "./testing.js";
import { type SessionPlan, StudyUniverse, rulesFor } from "./universe.js";

const CALENDAR = weekdays("2026-01-05", 25);
const DATES = CALENDAR.map((hours) => hours.session);
const at = (i: number) => DATES[i] as string;

interface Day {
  readonly close: number;
  readonly range?: number;
  readonly volume?: number;
  readonly splitFactor?: number | null;
  /** Shares per opening minute, five minutes. Null writes no minute bars that day. */
  readonly opening?: number | null;
}

/** One symbol over some sessions: its daily bars and its opening minutes. */
function series(symbol: string, days: ReadonlyMap<number, Day>): { daily: StoredBar[]; minute: SymbolBar[] } {
  const daily: StoredBar[] = [];
  const minute: SymbolBar[] = [];
  for (const [i, day] of days) {
    daily.push(
      dailyBar(symbol, at(i), day.close, {
        range: day.range ?? 1,
        volume: day.volume ?? 2_000_000,
        splitFactor: day.splitFactor === undefined ? 1 : day.splitFactor,
      }),
    );
    if (day.opening !== null) {
      minute.push(...quietMinutes(symbol, at(i), day.close, { volume: day.opening ?? 100 }));
    }
  }
  return { daily, minute };
}

/** Sessions first..last inclusive, each the same day, and a busier opening on `busy`. */
function steady(first: number, last: number, day: Day, busy?: { index: number; opening: number }) {
  const days = new Map<number, Day>();
  for (let i = first; i <= last; i += 1) {
    days.set(i, busy?.index === i ? { ...day, opening: busy.opening } : day);
  }
  return days;
}

function universe(
  symbols: ReadonlyArray<{ daily: StoredBar[]; minute: SymbolBar[] }>,
  options: {
    topN?: number;
    exclude?: string[];
    from?: string;
    loaded?: string[];
    calendar?: SessionHours[];
  } = {},
) {
  const config = testConfig();
  const rules = {
    ...rulesFor(config),
    topN: options.topN ?? 20,
    excludeSymbols: new Set(options.exclude ?? []),
  };
  const source = new MemoryStudySource({
    dailyBars: symbols.flatMap((s) => s.daily),
    minuteBars: symbols.flatMap((s) => s.minute),
    ...(options.loaded === undefined ? {} : { loaded: options.loaded }),
  });
  const calendar = (options.calendar ?? CALENDAR).map((hours) => hours.session);
  return { source, universe: new StudyUniverse(source, rules, calendar, options.from ?? at(0)) };
}

const names = (plan: SessionPlan) => plan.inPlay.map((name) => name.symbol);

describe("the screen", () => {
  it("judges each session on the sessions before it, both price ends included, volume and ATR strictly above", async () => {
    const busy = { index: 14, opening: 1_000 };
    const { universe: u } = universe([
      series("EDGE5", steady(0, 14, { close: 5 }, busy)),
      series("EDGE100", steady(0, 14, { close: 100 }, busy)),
      series("UNDER", steady(0, 14, { close: 4.99 }, busy)),
      series("OVER", steady(0, 14, { close: 100.01 }, busy)),
      series("VOL1M", steady(0, 14, { close: 20, volume: 1_000_000 }, busy)),
      series("ATR50", steady(0, 14, { close: 20, range: 0.5 }, busy)),
      // Its own day's bar is wild, and changes nothing: only the sessions before count.
      series(
        "OK",
        new Map([...steady(0, 13, { close: 20 }), [14, { close: 500, range: 90, opening: 1_000 }]]),
      ),
    ]);
    // Thirteen sessions of history is one short.
    expect((await u.plan(at(13))).eligible).toBe(0);
    const plan = await u.plan(at(14));
    expect(plan.eligible).toBe(3);
    expect(plan.qualified).toBe(3);
    // Every opening RVOL is 10x, so the tie goes by symbol, code unit order.
    expect(names(plan)).toEqual(["EDGE100", "EDGE5", "OK"]);
    expect(plan.inPlay[2]).toEqual({
      symbol: "OK",
      rank: 3,
      openingRvol: 100_000,
      dailyAtr: px(1),
      priorClose: px(20),
      averageVolume: 2_000_000,
    });
  });

  it("drops a symbol whose lookback reaches outside the last 20 sessions of the calendar", async () => {
    const busy = (days: Map<number, Day>) => days.set(21, { close: 20, opening: 1_000 });
    const gaps = (first: number[], second: number[]) =>
      busy(new Map([...first, ...second].map((i): [number, Day] => [i, { close: 20 }])));
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const { universe: u } = universe([
      // Fourteen sessions spanning sessions 1 to 20: all inside the 20 before session 21.
      series("INSIDE", gaps(range(1, 7), range(14, 20))),
      // Fourteen spanning 0 to 20: the oldest is 21 sessions back.
      series("OUTSIDE", gaps(range(0, 6), range(14, 20))),
    ]);
    expect(names(await u.plan(at(21)))).toEqual(["INSIDE"]);
  });

  it("leaves out the exclusion list", async () => {
    const busy = { index: 14, opening: 1_000 };
    const { universe: u } = universe(
      [series("SPY", steady(0, 14, { close: 20 }, busy)), series("AAA", steady(0, 14, { close: 20 }, busy))],
      { exclude: ["SPY"] },
    );
    const plan = await u.plan(at(14));
    expect([plan.eligible, names(plan)]).toEqual([1, ["AAA"]]);
  });
});

describe("the ranking", () => {
  it("ranks by opening RVOL, floored to basis points, strictly above 1, and keeps the top N", async () => {
    const day = { close: 20 };
    const { universe: u } = universe(
      [
        series("AAA", steady(0, 14, day, { index: 14, opening: 1_000 })),
        series("BBB", steady(0, 14, day, { index: 14, opening: 2_000 })),
        series("CCC", steady(0, 14, day, { index: 14, opening: 1_000 })),
        // Exactly 100% is not above it.
        series("DDD", steady(0, 14, day, { index: 14, opening: 100 })),
        // Three shares a minute against ten today: 50 * 14 * 10000 / 210 is 33333.3, floored.
        series("GGG", steady(0, 14, { ...day, opening: 3 }, { index: 14, opening: 10 })),
      ],
      { topN: 2 },
    );
    const plan = await u.plan(at(14));
    expect([plan.eligible, plan.qualified]).toEqual([5, 4]);
    expect(plan.inPlay.map((n) => [n.symbol, n.rank, n.openingRvol])).toEqual([
      ["BBB", 1, 200_000],
      ["AAA", 2, 100_000],
    ]);
  });

  it("reports a name that traded today but has nothing to rank on, and never guesses", async () => {
    const day = { close: 20 };
    const { universe: u } = universe(
      [
        series("OK", steady(0, 21, day, { index: 21, opening: 1_000 })),
        // Minute bars in February only: its January lookback sessions were never loaded.
        series(
          "HOLE",
          new Map(
            [...steady(0, 21, day)].map(([i, d]) => [i, at(i) < "2026-02" ? { ...d, opening: null } : d]),
          ),
        ),
        // Loaded, and nothing traded in the opening minutes of any lookback session.
        series("QUIET", steady(0, 21, { ...day, opening: 0 }, { index: 21, opening: 1_000 })),
        // Traded today, and February's minute bars were never loaded.
        series(
          "TODAY",
          new Map([...steady(0, 21, day)].map(([i, d]) => [i, i >= 20 ? { ...d, opening: null } : d])),
        ),
        // Stopped trading after session 17, still inside its window, with no February minutes: gone, not a hole.
        series("GONE", steady(0, 17, day)),
      ],
      { from: at(21) },
    );
    const plan = await u.plan(at(21));
    expect(plan.eligible).toBe(5);
    expect(names(plan)).toEqual(["OK"]);
    expect(plan.unrankable).toEqual([
      { symbol: "HOLE", reason: "minutesNotLoaded" },
      { symbol: "QUIET", reason: "baselineEmpty" },
      { symbol: "TODAY", reason: "minutesNotLoaded" },
    ]);
  });
});

describe("splits", () => {
  // A 2:1 split at the open of session 17. Before it the stock traded at $40 on half the shares.
  const SPLIT = 17;
  const before = { close: 40, range: 2, volume: 1_500_000, splitFactor: 2, opening: 60 };
  const after = { close: 20, range: 1, volume: 3_000_000, splitFactor: 1, opening: 120 };
  const twin = { close: 20, range: 1, volume: 3_000_000, splitFactor: 1, opening: 120 };
  // A busy open on sessions 15 and 21: the same shares on today's basis, so half as many before the split.
  const withBusy = (days: Map<number, Day>) => {
    for (const i of [15, 21]) {
      const day = days.get(i) as Day;
      days.set(i, { ...day, opening: day.splitFactor === 2 ? 500 : 1_000 });
    }
    return days;
  };

  it("puts a lookback across a split on the session's own share basis, and a split after it changes nothing", async () => {
    const split = new Map<number, Day>();
    const missing = new Map<number, Day>();
    for (let i = 0; i <= 21; i += 1) {
      split.set(i, i < SPLIT ? before : after);
      // Some bars with no factor: each takes the latest one before it, never a later one.
      missing.set(
        i,
        i < SPLIT
          ? { ...before, splitFactor: i % 4 === 1 ? null : 2 }
          : { ...after, splitFactor: i === SPLIT ? 1 : null },
      );
    }
    const { universe: u } = universe(
      [
        series("SPLIT", withBusy(split)),
        series("NOFACTOR", withBusy(missing)),
        series("TWIN", withBusy(steady(0, 21, twin))),
      ],
      { from: at(15) },
    );
    const summary = (plan: SessionPlan) =>
      Object.fromEntries(plan.inPlay.map(({ symbol, rank: _rank, ...rest }) => [symbol, rest]));

    // Session 15 is before the split: SPLIT still trades at $40, and nothing from after it leaks in.
    const early = summary(await u.plan(at(15)));
    expect(early["SPLIT"]).toEqual({
      openingRvol: early["TWIN"]?.openingRvol,
      dailyAtr: px(2),
      priorClose: px(40),
      averageVolume: 1_500_000,
    });
    expect(early["NOFACTOR"]).toEqual(early["SPLIT"]);

    // Session 21 looks back across the split: restated, it is the twin.
    const late = summary(await u.plan(at(21)));
    expect(late["SPLIT"]).toEqual(late["TWIN"]);
    expect(late["NOFACTOR"]).toEqual(late["TWIN"]);
    expect(late["TWIN"]).toMatchObject({ dailyAtr: px(1), priorClose: px(20), averageVolume: 3_000_000 });
  });
});

describe("walking the calendar", () => {
  it("reads each month once, and opening volumes only where a lookback can reach", async () => {
    const calendar = weekdays("2026-01-05", 60);
    const march = calendar.findIndex((hours) => hours.session >= "2026-03-02");
    const { source, universe: u } = universe([], {
      calendar,
      from: (calendar[march] as SessionHours).session,
    });
    for (const hours of calendar.slice(march)) {
      await u.plan(hours.session);
    }
    // Twenty sessions before 2026-03-02 is early February, so January's opening minutes are never read.
    expect(source.calls).toEqual([
      "dailyBars 2026-01",
      "dailyBars 2026-02",
      "openingVolumes 2026-02",
      "dailyBars 2026-03",
      "openingVolumes 2026-03",
    ]);
  });

  it("plans sessions in order, and only sessions of its calendar", async () => {
    const { universe: u } = universe([]);
    await u.plan(at(3));
    await expect(u.plan(at(3))).rejects.toThrow(/already planned/);
    await expect(u.plan(at(2))).rejects.toThrow(/already planned/);
    await expect(u.plan("2026-01-10")).rejects.toThrow(/not in the study calendar/);
  });
});
