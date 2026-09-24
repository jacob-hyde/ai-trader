import type { SessionHours } from "@trader/adapters";
import type { Fixed, Ratio } from "@trader/contracts";
import { SCRIPTED_SCENARIOS, type Scenario } from "@trader/core";
import { describe, expect, it } from "vitest";
import { type RunConfig, costModelFor } from "./config.js";
import { type DiagnosticsSettings, diagnostics, estimate, select } from "./diagnostics.js";
import type { TradeRecord } from "./records.js";
import { reprice } from "./recost.js";
import { runBacktest } from "./run.js";
import { dependencies, halfDay, registrationFor, syntheticMarket, testConfig, weekdays } from "./testing.js";

const WARMUP = weekdays("2026-01-05", 20);
const SESSIONS: SessionHours[] = weekdays("2026-02-02", 5).map((h, i) => (i === 4 ? halfDay(h) : h));
const SYMBOLS = Array.from({ length: 16 }, (_, i) => `G${String(i).padStart(2, "0")}`);
const SCENARIOS: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];
const SETTINGS: DiagnosticsSettings = {
  exits: ["A", "B"],
  costScales: [0.5, 1.5, 2],
  rvolBuckets: [
    [1, 5],
    [6, 10],
    [11, 20],
  ],
  breakEvenMaxBps: 1_000,
};

/** The pre-registered variants on a synthetic market, the gate strict enough to reject some signals. */
function config(): RunConfig {
  const eod = { kind: "eod" };
  const twoR = { kind: "fixedR", targetR: 2, breakevenAtR: 1 };
  return testConfig({
    maxCostToRisk: 0.1,
    variants: [
      { id: "A", stop: { kind: "openingRange" }, exit: eod },
      { id: "B", stop: { kind: "openingRange" }, exit: twoR },
      { id: "atr10A", stop: { kind: "atrFraction", fraction: 0.1 }, exit: eod },
      { id: "atr10B", stop: { kind: "atrFraction", fraction: 0.1 }, exit: twoR },
      { id: "atr50A", stop: { kind: "atrFraction", fraction: 0.5 }, exit: eod },
      { id: "atr50B", stop: { kind: "atrFraction", fraction: 0.5 }, exit: twoR },
    ],
  });
}

async function records(): Promise<TradeRecord[]> {
  const market = syntheticMarket({
    symbols: SYMBOLS,
    warmup: WARMUP,
    sessions: SESSIONS,
    scenario: (symbol, session) =>
      SCENARIOS[
        (SYMBOLS.indexOf(symbol) + SESSIONS.findIndex((h) => h.session === session)) % SCENARIOS.length
      ] as Scenario,
  });
  const out: TradeRecord[] = [];
  await runBacktest(config(), dependencies(market, registrationFor({ holdoutFrom: "2027-01-04" })), {
    onSession: (result) => void out.push(...result.records),
  });
  return out;
}

describe("section 7's diagnostics", async () => {
  const all = await records();
  const model = costModelFor(config());
  const d = diagnostics(all, model, SETTINGS);

  it("sets the gate's passed signals against its rejected ones, each exit (H3)", () => {
    for (const row of d.gate) {
      expect(row.passed.trades).toBe(select(all, row.exit, "long").length);
      expect(row.passed.trades + row.rejected.trades).toBe(select(all, row.exit, "long", "off").length);
    }
    expect(d.gate.some((row) => row.rejected.trades > 0 && row.passed.trades > 0)).toBe(true);
  });

  it("measures the published stop with the gate off, and the 50% ATR stop with it on", () => {
    for (const row of d.publishedStop) {
      expect(row.variant).toBe(`atr10${row.exit}`);
      expect(row.estimate.trades).toBe(select(all, row.variant, "long", "off").length);
      expect(row.signals).toBeGreaterThanOrEqual(row.estimate.trades);
    }
    expect(d.atr50.map((row) => [row.variant, row.estimate.trades])).toEqual(
      ["A", "B"].map((exit) => [`atr50${exit}`, select(all, `atr50${exit}`, "long").length]),
    );
  });

  it("splits the confirmatory trades into RVOL buckets that add up to them, and measures the shorts", () => {
    for (const row of d.rvolBuckets) {
      expect(row.buckets.map((b) => [b.from, b.to])).toEqual(SETTINGS.rvolBuckets);
      expect(row.buckets.reduce((n, b) => n + b.estimate.trades, 0)).toBe(
        select(all, row.exit, "long").length,
      );
    }
    expect(d.shorts.map((row) => row.estimate)).toEqual(
      ["A", "B"].map((exit) => estimate(select(all, exit, "short"))),
    );
  });

  it("reprices every confirmatory trade to its record first, then scales slippage on the same trades", () => {
    expect(d.costs.mismatch).toBeNull();
    expect(d.costs.checked).toBe(select(all, "A", "long").length + select(all, "B", "long").length);
    for (const row of d.costs.sensitivity) {
      expect(row.rows.map((r) => r.scale)).toEqual([0.5, 1, 1.5, 2]);
      const at = (scale: number) => row.rows.find((r) => r.scale === scale)?.estimate;
      expect(at(1)).toEqual(estimate(select(all, row.exit, "long")));
      expect(at(0.5)?.meanR ?? 0).toBeGreaterThan(at(1)?.meanR ?? 0);
      expect(at(2)?.meanR ?? 0).toBeLessThan(at(1.5)?.meanR ?? 0);
      expect(new Set(row.rows.map((r) => r.estimate.trades)).size).toBe(1);
    }
  });

  it("reports nothing about costs when the repricing does not reproduce a recorded fill", () => {
    const tampered = all.map((t) =>
      t.variant === "A" && t.direction === "long" && t.gatePassed && t.entryOutcome === "filled"
        ? { ...t, entryFill: (t.entryFill as number) + 1 }
        : t,
    ) as TradeRecord[];
    const broken = diagnostics(tampered, model, SETTINGS);
    expect(broken.costs.mismatch).toMatch(/^A /);
    expect(broken.costs.sensitivity).toEqual([]);
    expect(broken.costs.breakEven).toEqual([]);
  });
});

describe("the break-even stop-entry allowance", () => {
  const model = costModelFor(testConfig());
  /** A long from $20.00 with a $1.00 stop that exits at `exit` dollars on a target. */
  const trade = (session: string, exit: number): TradeRecord =>
    ({
      variant: "A",
      symbol: "BE",
      session,
      direction: "long",
      rank: 1,
      gatePassed: true,
      entryOutcome: "filled",
      entry: 200_000 as Fixed,
      stop: 190_000 as Fixed,
      shares: 1,
      entryReference: 200_000 as Fixed,
      exitReference: Math.round(exit * 10_000) as Fixed,
      exitReason: "target",
      netR: 0 as Ratio,
    }) as TradeRecord;

  it("finds where mean net R crosses zero, to a hundredth of a basis point", () => {
    const trades = [trade("2026-02-02", 20.3), trade("2026-02-03", 20.05), trade("2026-02-04", 19.9)].map(
      (t) => ({
        ...t,
        ...reprice(t, model),
      }),
    );
    const d = diagnostics(trades, model, { ...SETTINGS, exits: ["A"] });
    const [found] = d.costs.breakEven;
    const bps = found?.stopEntryBps as number;
    const meanAt = (b: number) =>
      trades.reduce((n, t) => n + reprice(t, model, { stopEntryBps: b }).netR, 0) / 3;
    expect(meanAt(bps - 0.02)).toBeGreaterThan(0);
    expect(meanAt(bps + 0.02)).toBeLessThanOrEqual(0);
    expect(found?.aboveCeiling).toBe(false);
    // Modeled: 10 bps of the $20.01 ask, rounded up, against the 2-tick floor of $0.02.
    expect(found?.modeledBps).toBeCloseTo((Math.ceil(200_100 * 0.001) / 200_100) * 10_000, 8);
  });

  it("has none when a free stop entry still loses, and says so when the ceiling cannot reach zero", () => {
    const losing = [trade("2026-02-02", 19.5)].map((t) => ({ ...t, ...reprice(t, model) }));
    expect(diagnostics(losing, model, { ...SETTINGS, exits: ["A"] }).costs.breakEven[0]).toMatchObject({
      stopEntryBps: null,
      aboveCeiling: false,
    });
    const huge = [trade("2026-02-02", 60)].map((t) => ({ ...t, ...reprice(t, model) }));
    expect(diagnostics(huge, model, { ...SETTINGS, exits: ["A"] }).costs.breakEven[0]).toMatchObject({
      stopEntryBps: 1_000,
      aboveCeiling: true,
    });
    expect(diagnostics([], model, { ...SETTINGS, exits: ["A"] }).costs.breakEven[0]).toMatchObject({
      stopEntryBps: null,
      modeledBps: null,
    });
  });
});
