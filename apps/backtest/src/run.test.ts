import { describe, expect, it } from "vitest";
import { MemoryReplaySource, type SessionHours } from "@trader/adapters";
import type { SymbolBar } from "@trader/contracts";
import {
  BadTickFilter,
  SCRIPTED_SCENARIOS,
  type Scenario,
  type SymbolState,
  buildBracket,
  planTrade,
  ratio,
  simulateTrade,
} from "@trader/core";
import { costModelFor, loadVariant } from "./config.js";
import { RunRefused } from "./guard.js";
import type { FillRecord, TradeRecord } from "./records.js";
import { type RunDependencies, type RunProgress, type SessionResult, runBacktest } from "./run.js";
import {
  CLEAN,
  type Market,
  dailyBar,
  dependencies,
  halfDay,
  minutesOf,
  px,
  quietMinutes,
  registrationFor,
  syntheticMarket,
  testConfig,
  weekdays,
} from "./testing.js";

const WARMUP = weekdays("2026-01-05", 20);
const [MON, TUE, WED, THU, FRI] = weekdays("2026-02-02", 5) as [
  SessionHours,
  SessionHours,
  SessionHours,
  SessionHours,
  SessionHours,
];
/** The Friday closes early, so a half day's cutoffs are exercised too. */
const SESSIONS = [MON, TUE, WED, THU, halfDay(FRI)];
const SYMBOLS = Array.from({ length: 12 }, (_, i) => `S${String(i).padStart(2, "0")}`);
const SCENARIOS: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];
const REGISTRATION = registrationFor({ holdoutFrom: "2027-01-04" });

function market(): Market {
  return syntheticMarket({
    symbols: SYMBOLS,
    warmup: WARMUP,
    sessions: SESSIONS,
    scenario: (symbol, session) =>
      SCENARIOS[
        (SYMBOLS.indexOf(symbol) + SESSIONS.findIndex((h) => h.session === session)) % SCENARIOS.length
      ] as Scenario,
  });
}

async function collect(
  config = testConfig(),
  deps: RunDependencies = dependencies(market(), REGISTRATION),
): Promise<{
  results: SessionResult[];
  records: TradeRecord[];
  fills: FillRecord[];
  summary: Awaited<ReturnType<typeof runBacktest>>;
}> {
  const results: SessionResult[] = [];
  const summary = await runBacktest(config, deps, { onSession: (result) => void results.push(result) });
  return {
    results,
    records: results.flatMap((r) => [...r.records]),
    fills: results.flatMap((r) => [...r.fills]),
    summary,
  };
}

describe("the engine agrees with the trade simulator on the same bars", () => {
  it("for every signal, variant, and direction, full days and a half day", async () => {
    const config = testConfig();
    const data = market();
    const { records, summary } = await collect(config, dependencies(data, REGISTRATION));
    const costModel = costModelFor(config);
    const seen = { filled: 0, canceled: 0, refused: 0, reasons: new Set<string>(), shorts: 0, compared: 0 };

    for (const hours of SESSIONS) {
      const minutes = minutesOf(hours);
      for (const symbol of SYMBOLS) {
        // What the broker and the engine see: the stored bars through the bad-tick filter.
        const filter = new BadTickFilter();
        const bars = data.minute
          .filter((b) => b.symbol === symbol && b.session === hours.session)
          .sort((a, b) => a.minuteOfSession - b.minuteOfSession)
          .map((b) => filter.filter(b).bar);
        const proof = bars.findIndex((b) => b.minuteOfSession >= 4);
        const upTo = bars.slice(0, proof + 1);
        const last = upTo.at(-1) as SymbolBar;
        for (const variant of config.variants) {
          const where = `${variant.id} ${symbol} ${hours.session}`;
          const record = records.find(
            (r) => r.variant === variant.id && r.symbol === symbol && r.session === hours.session,
          );
          const state: SymbolState = {
            symbol,
            session: hours.session,
            minuteOfSession: last.minuteOfSession,
            lastClose: last.close,
            dailyAtr: px(1),
            rsi: null,
            sessionVwap: null,
            openingRvol: record?.openingRvol ?? ratio(1_000_000),
            runningRvol: null,
          };
          const setup = loadVariant(config, variant);
          const signal = setup.detectTrigger(state, upTo, null);
          if (signal === null) {
            expect(record, where).toBeUndefined();
            continue;
          }
          const plan = planTrade(setup, signal, state);
          expect(record, where).toMatchObject({
            direction: signal.direction,
            signalMinute: signal.minuteOfSession,
            entry: signal.entry,
            stop: plan.stop,
            target: plan.target,
            dailyAtr: px(1),
          });
          const r = record as TradeRecord;
          seen.shorts += r.direction === "short" ? 1 : 0;
          if (r.refusal !== null) {
            seen.refused += 1;
            expect(buildBracket({ plan, shares: 10 }).ok, where).toBe(false);
            continue;
          }
          const expected = simulateTrade(plan, bars, {
            shares: 10,
            costModel,
            lastEntryMinute: minutes - 30,
            flattenMinute: minutes - 10,
          });
          seen.compared += 1;
          if (!expected.filled) {
            seen.canceled += 1;
            expect([expected.reason, r.entryOutcome], where).toEqual(["NEVER_TRIGGERED", "canceled"]);
            continue;
          }
          seen.filled += 1;
          seen.reasons.add(`${r.exitReason ?? ""}`);
          expect(
            {
              entryOutcome: r.entryOutcome,
              entryMinute: r.entryMinute,
              entryReference: r.entryReference,
              entryFill: r.entryFill,
              exitMinute: r.exitMinute,
              exitReference: r.exitReference,
              exitFill: r.exitFill,
              exitReason: r.exitReason === "flatten" || r.exitReason === "close" ? "eod" : r.exitReason,
              grossPnl: r.grossPnl,
              netPnl: r.netPnl,
              grossR: r.grossR,
              netR: r.netR,
            },
            where,
          ).toEqual({
            entryOutcome: "filled",
            entryMinute: expected.entryMinute,
            entryReference: expected.entryReference,
            entryFill: expected.entryFill,
            exitMinute: expected.exitMinute,
            exitReference: expected.exitReference,
            exitFill: expected.exitFill,
            exitReason: expected.exitReason,
            grossPnl: expected.grossPnl,
            netPnl: expected.netPnl,
            grossR: expected.grossR,
            netR: expected.netR,
          });
        }
      }
    }
    // Enough of everything to mean something.
    expect(seen.compared).toBeGreaterThan(80);
    expect(seen.filled).toBeGreaterThan(40);
    // Every synthetic entry here triggers; the session's clock tests below cover one that never does.
    expect(seen.shorts).toBeGreaterThan(0);
    expect([...seen.reasons].sort()).toEqual(["breakevenStop", "flatten", "stop", "target"]);
    expect(records.length).toBe(seen.compared + seen.refused);
    expect(summary.signals * config.variants.length).toBe(records.length);
    expect(summary.outcomes?.closedAtSessionEnd).toBe(0);
    expect(summary.outcomes?.expiredEntries).toBe(0);
  });
});

/**
 * One symbol in play on one session: a bullish opening range with its high at $20.20 and low at $19.95,
 * quiet below the entry, then a single bar at minute `touch` that reaches $20.30. After it, bars every
 * minute through `lastBar`.
 */
function oneSignal(
  session: SessionHours,
  touch: number,
  lastBar = minutesOf(session) - 1,
  missing: readonly number[] = [],
): Market {
  const symbol = "ONE";
  const daily = [...WARMUP, session].map((hours) => dailyBar(symbol, hours.session, 20));
  const minute: SymbolBar[] = WARMUP.flatMap((hours) => quietMinutes(symbol, hours.session, 20));
  const bar = (m: number, o: number, h: number, l: number, c: number): SymbolBar => ({
    symbol,
    session: session.session,
    minuteOfSession: m,
    open: px(o),
    high: px(h),
    low: px(l),
    close: px(c),
    volume: 10_000,
    vwap: null,
    closed: true,
  });
  minute.push(
    bar(0, 20, 20.05, 19.95, 20.02),
    bar(1, 20.02, 20.1, 20.0, 20.08),
    bar(2, 20.08, 20.2, 20.05, 20.1),
    bar(3, 20.1, 20.12, 20.04, 20.06),
    bar(4, 20.06, 20.12, 20.02, 20.1),
  );
  for (let m = 5; m <= lastBar; m += 1) {
    minute.push(
      m === touch
        ? bar(m, 20.05, 20.3, 20.05, 20.25)
        : m > touch
          ? bar(m, 20.25, 20.26, 20.24, 20.25)
          : bar(m, 20.05, 20.06, 20.04, 20.05),
    );
  }
  const kept = minute.filter((b) => b.session !== session.session || !missing.includes(b.minuteOfSession));
  return { sessions: [...WARMUP, session], daily, minute: kept };
}

describe("the session's clock", () => {
  const onlyA = testConfig({
    from: MON.session,
    to: MON.session,
    variants: [{ id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } }],
  });
  const half = halfDay(MON);

  it("lets an entry fill up to the bar before the cutoff, and cancels it there: 360 on a full day, 180 on a half", async () => {
    const outcome = async (session: SessionHours, touch: number) => {
      const { records } = await collect(onlyA, dependencies(oneSignal(session, touch), REGISTRATION));
      return records.map((r) => [r.entryOutcome, r.entryMinute]);
    };
    expect(await outcome(MON, 359)).toEqual([["filled", 359]]);
    expect(await outcome(MON, 360)).toEqual([["canceled", null]]);
    expect(await outcome(half, 179)).toEqual([["filled", 179]]);
    expect(await outcome(half, 180)).toEqual([["canceled", null]]);
  });

  it("flattens at the open of the first bar at or after the flatten minute, else at the bell", async () => {
    const exit = async (session: SessionHours, lastBar: number) => {
      const { records } = await collect(onlyA, dependencies(oneSignal(session, 10, lastBar), REGISTRATION));
      return records.map((r) => [r.exitReason, r.exitMinute, r.exitReference]);
    };
    expect(await exit(MON, 389)).toEqual([["flatten", 380, px(20.25)]]);
    expect(await exit(half, 209)).toEqual([["flatten", 200, px(20.25)]]);
    // Nothing prints after minute 370: the position goes out at its last close, at the bell.
    expect(await exit(MON, 370)).toEqual([["close", 370, px(20.25)]]);
  });

  it("waits for proof the range closed: a name with no bar at minute 4 is asked at its next bar", async () => {
    const late = await collect(onlyA, dependencies(oneSignal(MON, 10, 389, [4]), REGISTRATION));
    expect(late.records.map((r) => [r.signalMinute, r.entry, r.stop, r.entryMinute])).toEqual([
      [5, px(20.2), px(19.95), 10],
    ]);
    // By its first bar after the range it had already traded through the entry: no chasing, no signal.
    const through = await collect(onlyA, dependencies(oneSignal(MON, 5, 389, [4]), REGISTRATION));
    expect([through.summary.signals, through.records]).toEqual([0, []]);
  });

  it("never places an order before the opening range has closed", async () => {
    const { records, fills } = await collect();
    expect(records.every((r) => r.signalMinute >= 4)).toBe(true);
    expect(Math.min(...fills.map((f) => f.minute))).toBeGreaterThanOrEqual(5);
  });
});

describe("a plan no order can express", () => {
  it("is recorded as refused for that variant, and the run goes on", async () => {
    // A bearish range from $7.60 down to $5.00: short at $5.00, stop $7.60, so 2R is $5.20 below entry.
    const session = MON.session;
    const data = oneSignal(MON, 400);
    const wide = (m: number, o: number, h: number, l: number, c: number): SymbolBar => ({
      symbol: "ONE",
      session,
      minuteOfSession: m,
      open: px(o),
      high: px(h),
      low: px(l),
      close: px(c),
      volume: 10_000,
      vwap: null,
      closed: true,
    });
    const range = [
      wide(0, 7.5, 7.6, 7.0, 7.2),
      wide(1, 7.2, 7.3, 6.5, 6.6),
      wide(2, 6.6, 6.7, 5.8, 5.9),
      wide(3, 5.9, 6.0, 5.3, 5.4),
      wide(4, 5.4, 5.5, 5.0, 5.2),
    ];
    const market: Market = {
      ...data,
      minute: [...data.minute.filter((b) => b.session !== session || b.minuteOfSession > 4), ...range],
    };
    const config = testConfig({
      from: session,
      to: session,
      variants: [
        { id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } },
        { id: "B", stop: { kind: "openingRange" }, exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 } },
      ],
    });
    const { records, results } = await collect(config, dependencies(market, REGISTRATION));
    expect(records.map((r) => [r.variant, r.direction, r.stop, r.entryOutcome, r.refusal])).toEqual([
      ["B", "short", null, "refused", expect.stringMatching(/^plan: .*target is not a positive price/)],
      // The EOD variant's order went in. The day trades near $20 after the range, so it never fills.
      ["A", "short", px(7.6), "canceled", null],
    ]);
    expect(results[0]?.stats.byVariant).toEqual({
      A: { gatePassed: 1, refused: 0 },
      B: { gatePassed: 0, refused: 1 },
    });
  });
});

describe("the bad-tick filter", () => {
  it("cuts a bad print before the broker sees it, records the cut, and off replays the print", async () => {
    const on = await collect(testConfig());
    const off = await collect(testConfig({ badTicks: null }));
    const cuts = on.results.flatMap((r) => r.badTicks ?? []);
    // Every badTick-scenario session has its one spike at minute 6, and nothing else is cut.
    const spiked = market()
      .minute.filter((b) => b.minuteOfSession === 6 && (b.high > b.open * 1.15 || b.low < b.open * 0.85))
      .map((b) => `${b.session} ${b.symbol}`);
    expect(spiked.length).toBeGreaterThan(5);
    expect(
      on.results.flatMap((r) => (r.badTicks ?? []).map((c) => `${r.stats.session} ${c.symbol}`)).sort(),
    ).toEqual(spiked.sort());
    expect(
      cuts.every((c) => c.minute === 6 && (c.side === "high" ? c.reported > c.limit : c.reported < c.limit)),
    ).toBe(true);
    expect([on.summary.badTickFilter, on.summary.outcomes?.badTicks]).toEqual(["on", cuts.length]);
    expect([off.summary.badTickFilter, off.summary.outcomes?.badTicks]).toEqual(["off", 0]);
    expect(off.results.flatMap((r) => r.badTicks ?? [])).toEqual([]);
    // Unfiltered, a spike decides the trade at minute 6; filtered, never.
    const atSpike = (records: readonly TradeRecord[]) =>
      records.filter((r) => r.exitMinute === 6 && spiked.includes(`${r.session} ${r.symbol}`)).length;
    expect(atSpike(off.records)).toBeGreaterThan(0);
    expect(atSpike(on.records)).toBe(0);
  });
});

describe("progress", () => {
  it("reports the screen warming up on months before the first session, then every session", async () => {
    const progress: RunProgress[] = [];
    await runBacktest(testConfig(), dependencies(market(), REGISTRATION), {
      onProgress: (p) => void progress.push(p),
    });
    expect(progress[0]).toMatchObject({ phase: "warmup", month: "2026-01" });
    const replay = progress.filter((p) => p.phase === "replay");
    expect(
      replay.map((p) => (p.phase === "replay" ? [p.session, p.sessionsDone, p.sessionsTotal] : [])),
    ).toEqual(SESSIONS.map((hours, i) => [hours.session, i + 1, 5]));
  });
});

describe("the year-by-year table (L.6)", () => {
  it("splits every variant's trades by calendar year, and the years add up to the whole", async () => {
    const warmup = weekdays("2025-11-17", 20);
    const sessions = weekdays("2025-12-29", 6);
    const data = syntheticMarket({
      symbols: SYMBOLS,
      warmup,
      sessions,
      scenario: (symbol, session) =>
        SCENARIOS[
          (SYMBOLS.indexOf(symbol) + sessions.findIndex((h) => h.session === session)) % SCENARIOS.length
        ] as Scenario,
    });
    const config = testConfig({ from: "2025-12-29", to: sessions.at(-1)?.session ?? "" });
    const { records, summary } = await collect(config, dependencies(data, REGISTRATION));
    const outcomes = summary.outcomes?.byVariant ?? [];
    expect(outcomes.length).toBeGreaterThan(0);
    for (const v of outcomes) {
      const traded = records.filter(
        (r) => r.variant === v.variant && r.direction === v.direction && r.gatePassed && r.netR !== null,
      );
      const inYear = (year: number) => traded.filter((r) => r.session.startsWith(String(year)));
      expect(v.byYear.map((y) => y.year)).toEqual([2025, 2026].filter((year) => inYear(year).length > 0));
      for (const y of v.byYear) {
        const net = inYear(y.year).map((r) => r.netR as number);
        expect(y.trades).toBe(net.length);
        expect(y.totalNetR).toBe(net.reduce((a, b) => a + b, 0));
        expect(y.meanNetR).toBe(Math.floor(y.totalNetR / y.trades));
      }
      expect(v.byYear.reduce((n, y) => n + y.trades, 0)).toBe(v.filled);
    }
    expect(outcomes.some((v) => v.byYear.length === 2)).toBe(true);
  });
});

describe("blind", () => {
  it("does the same work and keeps nothing after the range close", async () => {
    const open = await collect(testConfig());
    const blind = await collect(testConfig({ blind: true }));
    expect(blind.records).toEqual([]);
    expect(blind.fills).toEqual([]);
    expect(blind.results.every((r) => r.badTicks === null)).toBe(true);
    expect(blind.results.map((r) => r.stats)).toEqual(open.results.map((r) => r.stats));
    expect(blind.summary.outcomes).toBeNull();
    const { outcomes: _open, elapsedMs: _a, blind: _b, ...rest } = open.summary;
    const { outcomes: _none, elapsedMs: _c, blind: _d, ...same } = blind.summary;
    expect(same).toEqual(rest);
  });
});

describe("the registration", () => {
  it("takes its excluded sessions out of the calendar, as if the exchange had been closed", async () => {
    const data = market();
    const excluded = await collect(
      testConfig(),
      dependencies(data, registrationFor({ holdoutFrom: "2027-01-04", excluded: [TUE.session] })),
    );
    // The same market with Tuesday never in it at all.
    const gone: Market = {
      sessions: data.sessions.filter((h) => h.session !== TUE.session),
      daily: data.daily.filter((b) => b.session !== TUE.session),
      minute: data.minute.filter((b) => b.session !== TUE.session),
    };
    const absent = await collect(testConfig(), dependencies(gone, REGISTRATION));
    expect(excluded.summary.sessions).toBe(4);
    expect(excluded.records.some((r) => r.session === TUE.session)).toBe(false);
    expect(excluded.records).toEqual(absent.records);
    expect(excluded.summary.excludedSessions).toEqual([TUE.session]);
  });

  it("refuses a holdout session until a frozen configuration is committed, and then runs only it", async () => {
    const config = testConfig();
    const holdout = (frozen: typeof config | null) => registrationFor({ holdoutFrom: WED.session, frozen });
    const run = (registration: ReturnType<typeof holdout>, c = config, git = CLEAN) =>
      runBacktest(c, dependencies(market(), registration, git));

    await expect(run(holdout(null))).rejects.toThrow(RunRefused);
    await expect(run(holdout(null))).rejects.toThrow(/no.*frozen|none yet/);
    // Ending before the holdout needs nothing.
    await expect(run(holdout(null), testConfig({ to: TUE.session }))).resolves.toMatchObject({ sessions: 2 });
    // Blind is no way in.
    await expect(run(holdout(null), testConfig({ blind: true }))).rejects.toThrow(RunRefused);

    const frozen = testConfig({ name: "frozen on 2026-02-01" });
    await expect(run(holdout(frozen))).resolves.toMatchObject({ sessions: 5 });
    await expect(run(holdout(frozen), config, { commit: CLEAN.commit, dirty: true })).rejects.toThrow(
      /clean checkout/,
    );
    await expect(run(holdout(frozen), config, { commit: null, dirty: false })).rejects.toThrow(
      /clean checkout/,
    );
    await expect(
      run(holdout(frozen), testConfig({ universe: { ...config.universe, topN: 10 } })),
    ).rejects.toThrow(/not the frozen configuration/);
  });
});

describe("as deployed", () => {
  it("sizes each trade and lets the risk rules turn signals away", async () => {
    // Synthetic ranges are a few dimes on a $20 name, so at 0.15R the gate would refuse nearly all of them
    // before the rules saw one. A loose gate lets the rules do the refusing.
    const config = testConfig({
      variants: [{ id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } }],
      maxCostToRisk: 0.5,
      account: {
        kind: "asDeployed",
        startingCash: 100_000,
        riskPerTrade: 0.005,
        maxPositionPct: 0.25,
        maxGrossExposure: 1,
        maxConcurrentPositions: 2,
        maxOpenRisk: 0.02,
        dailyLossLimit: 0.05,
        flattenOnBreaker: false,
        micro: null,
      },
    });
    const { records } = await collect(config);
    const refusals = records.filter((r) => r.entryOutcome === "refused").map((r) => r.refusal as string);
    expect(
      refusals.some((reason) => reason.startsWith("risk: ") && reason.includes("MAX_CONCURRENT_POSITIONS")),
    ).toBe(true);
    expect(refusals.some((reason) => reason.startsWith("costToRisk: "))).toBe(true);
    const placed = records.filter((r) => r.entryOutcome !== "refused");
    expect(placed.length).toBeGreaterThan(0);
    // $500 of risk over a stop of a few dimes is hundreds of shares, capped at 25% of equity.
    // Sized on the session's opening equity: the notional cap binds at 25% of it, a stop of a few dimes
    // being far more shares on risk alone.
    for (const hours of SESSIONS) {
      const before = records.filter((r) => r.session < hours.session);
      const equity = 100_000 * 10_000 + before.reduce((sum, r) => sum + (r.netPnl ?? 0), 0);
      for (const r of placed.filter((p) => p.session === hours.session)) {
        const notional = r.shares * r.entry;
        expect(notional).toBeLessThanOrEqual(equity / 4);
        expect(notional + r.entry).toBeGreaterThan(equity / 4);
      }
    }
    // Every range closes at minute 4, so every signal is decided then, and two positions is the cap.
    expect(records.every((r) => r.signalMinute === 4)).toBe(true);
    for (const hours of SESSIONS) {
      const today = records.filter((r) => r.session === hours.session && r.entryOutcome !== "refused");
      expect(today.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("as deployed, in the validation regime", () => {
  it("refuses a name one share of which is over the micro notional cap", async () => {
    const config = testConfig({
      variants: [{ id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } }],
      maxCostToRisk: 0.5,
      account: {
        kind: "asDeployed",
        startingCash: 2_500,
        riskPerTrade: 0.015,
        maxPositionPct: 0.25,
        maxGrossExposure: 1,
        maxConcurrentPositions: 4,
        maxOpenRisk: 0.02,
        dailyLossLimit: 0.05,
        flattenOnBreaker: false,
        micro: { maxShares: 1, maxNotional: 10 },
      },
    });
    const { records } = await collect(config);
    const sized = records.filter((r) => !(r.refusal ?? "").startsWith("costToRisk"));
    expect(sized.length).toBeGreaterThan(0);
    expect(new Set(sized.map((r) => r.refusal))).toEqual(new Set(["sizing: BELOW_ONE_SHARE"]));
  });
});

describe("determinism and isolation", () => {
  it("gives the same records whatever the store's timing, and two runs at once do not touch each other", async () => {
    const data = market();
    const plain = await collect(testConfig(), dependencies(data, REGISTRATION));
    let seed = 7;
    const jitter = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % 3;
    };
    const jittered: RunDependencies = {
      ...dependencies(data, REGISTRATION),
      replay: new MemoryReplaySource({
        sessions: data.sessions,
        minuteBars: data.minute,
        dailyBars: data.daily,
        delay: jitter,
      }),
    };
    const [a, b] = await Promise.all([
      collect(testConfig(), jittered),
      collect(testConfig({ shorts: false }), dependencies(data, REGISTRATION)),
    ]);
    expect(a.records).toEqual(plain.records);
    expect(a.fills).toEqual(plain.fills);
    expect(b.records).toEqual(plain.records.filter((r) => r.direction === "long"));
  });
});

describe("failures", () => {
  it("stops the run with the store's error when a session cannot be kept", async () => {
    let sessions = 0;
    const failing = runBacktest(testConfig(), dependencies(market(), REGISTRATION), {
      onSession: () => {
        sessions += 1;
        if (sessions === 2) {
          throw new Error("disk full");
        }
      },
    });
    await expect(failing).rejects.toThrow("disk full");
    expect(sessions).toBe(2);
  });

  it("stops the run when the replay's source fails", async () => {
    const deps = dependencies(market(), REGISTRATION);
    const broken: RunDependencies = {
      ...deps,
      replay: {
        ...deps.replay,
        sessions: (from, to) => deps.replay.sessions(from, to),
        loaded: (session, symbols) => deps.replay.loaded(session, symbols),
        sessionBars: (hours, symbols) =>
          hours.session === WED.session
            ? Promise.reject(new Error("connection reset"))
            : deps.replay.sessionBars(hours, symbols),
        dailyBars: (symbol, from, to) => deps.replay.dailyBars(symbol, from, to),
        minuteBars: (symbol, from, to) => deps.replay.minuteBars(symbol, from, to),
        splitFactor: (symbol, session) => deps.replay.splitFactor(symbol, session),
      },
    };
    await expect(runBacktest(testConfig(), broken)).rejects.toThrow("connection reset");
  });
});
