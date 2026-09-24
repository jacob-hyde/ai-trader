import type { Fixed, Ratio } from "@trader/contracts";
import { createRng } from "@trader/core";
import { describe, expect, it } from "vitest";
import { canonical, costModelFor, parseRunConfig } from "./config.js";
import { checkRunAllowed } from "./guard.js";
import {
  type RunFacts,
  addendumBlock,
  asDeployedConfig,
  asDeployedResult,
  holdoutConfig,
  holdoutReport,
  inSampleReport,
  preconditions,
  verdictThresholds,
} from "./l2.js";
import { renderHoldoutReport, renderInSampleReport } from "./l2Text.js";
import type { NullModelRow } from "./nullModel.js";
import { preregisteredConfig } from "./preregistered.js";
import type { TradeRecord } from "./records.js";
import { reprice } from "./recost.js";
import { type Registration, loadRegistration, parseRegistration, REGISTRATION_PATH } from "./registration.js";
import type { RunRow } from "./store.js";
import { readFileSync } from "node:fs";

const REGISTRATION = await loadRegistration();
const EXPECTED = preregisteredConfig(REGISTRATION, { blind: false });
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MODEL = costModelFor(EXPECTED);

const passingNullModel: NullModelRow = {
  id: "4f0c0f0e-0000-4000-8000-000000000009",
  gitCommit: COMMIT,
  gitDirty: false,
  verdict: "pass",
  paths: 100_000,
  reports: {},
  elapsedMs: 150_000,
  createdAt: new Date("2026-09-24T12:00:00Z"),
};

function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "4f0c0f0e-0000-4000-8000-000000000001",
    name: EXPECTED.name,
    status: "completed",
    blind: false,
    config: EXPECTED,
    gitCommit: COMMIT,
    gitDirty: false,
    registrationVersion: REGISTRATION.thresholds.version,
    registrationSha256: REGISTRATION.sha256,
    dataSnapshot: { id: "abcdefabcdefabcd", facts: {} },
    progress: null,
    summary: { badTickFilter: "on" } as RunRow["summary"],
    error: null,
    createdAt: new Date("2026-09-24T12:30:00Z"),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const facts = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  run: runRow(),
  expected: EXPECTED,
  registration: REGISTRATION,
  nullModel: passingNullModel,
  etfListInCommit: true,
  unrankable: { baselineEmpty: 27 },
  ...overrides,
});

/**
 * A long from $20.00 with a $1.00 stop that leaves at `r` dollars from entry, priced by the cost model
 * so the diagnostics' repricing reproduces it.
 */
function trade(
  variant: string,
  session: string,
  symbol: string,
  rank: number,
  r: number,
  gatePassed = true,
): TradeRecord {
  const base = {
    variant,
    symbol,
    session,
    direction: "long",
    rank,
    openingRvol: 30_000 as Ratio,
    dailyAtr: 10_000 as Fixed,
    priorClose: 200_000 as Fixed,
    signalMinute: 4,
    entry: 200_000 as Fixed,
    stop: 190_000 as Fixed,
    target: null,
    costPerShare: 500 as Fixed,
    costToRisk: 500 as Ratio,
    gatePassed,
    refusal: null,
    shares: 1,
    entryOutcome: "filled",
    entryMinute: 6,
    entryReference: 200_000 as Fixed,
    exitMinute: 380,
    exitReason: r <= -1 ? "stop" : "flatten",
    exitReference: Math.round((20 + r) * 10_000) as Fixed,
    grossPnl: 0 as Fixed,
    grossR: 0 as Ratio,
  } as unknown as TradeRecord;
  const priced = reprice({ ...base, entryFill: null, exitFill: null, netPnl: null, netR: null }, MODEL);
  return { ...base, ...priced, netPnl: 0 as Fixed };
}

/** Two trades a session, ranks 3 and 14, eleven sessions a month, every in-sample year, with an edge in R. */
function inSampleTrades(edge: number, variants = ["A", "B"]): TradeRecord[] {
  const rng = createRng(4);
  const out: TradeRecord[] = [];
  for (let year = 2016; year <= 2023; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 10; day <= 20; day += 1) {
        const session = `${String(year)}-${String(month).padStart(2, "0")}-${String(day)}`;
        for (const [i, rank] of [3, 14].entries()) {
          const r = rng.next() < 0.35 ? 1.5 + rng.next() * 2 : -1;
          for (const variant of variants) {
            out.push(trade(variant, session, `S${String(i)}`, rank, r + edge));
          }
        }
      }
    }
  }
  return out;
}

describe("section 11 as L.2 reads it", () => {
  it("takes every gate and statistic from section 11", () => {
    const t = verdictThresholds(REGISTRATION.thresholds);
    expect(t).toEqual({
      inSample: { from: "2016-01-04", to: "2023-12-29", firstTradable: "2016-01-25" },
      minTrades: 2_000,
      minPositiveYears: 5,
      years: 8,
      leaveOneYearOutPositive: true,
      excludedRegimeYears: [2020, 2021],
      excludedRegimeMeanPositive: true,
      resamples: 20_000,
      seed: 20260922,
      familyAlpha: 0.05,
      notWorseZ: 1.96,
      topNChoices: [10, 20],
    });
  });

  it("builds the holdout run and the as-deployed run from the pre-registered one and the frozen choice", () => {
    const choice = { exit: "B", topN: 10, reason: "" };
    const holdout = holdoutConfig(EXPECTED, REGISTRATION.thresholds, choice);
    expect(holdout).toMatchObject({ from: "2024-01-02", to: "2026-08-31", shorts: false, blind: false });
    expect(holdout.variants.map((v) => v.id)).toEqual(["B"]);
    expect(holdout.universe.topN).toBe(10);
    expect(holdout.account).toEqual({ kind: "perSignal", shares: 1 });
    expect(canonical(parseRunConfig(JSON.parse(JSON.stringify(holdout))))).toBe(canonical(holdout));

    const deployed = asDeployedConfig(EXPECTED, REGISTRATION.thresholds, choice);
    expect(deployed).toMatchObject({ from: "2016-01-04", to: "2023-12-29", shorts: false });
    // Section 7: $2,500, 1x, 25% a position, 4 at once, 2% open risk, 5% breaker without a flatten, 1.5% a trade.
    expect(deployed.account).toEqual({
      kind: "asDeployed",
      startingCash: 2_500,
      riskPerTrade: 0.015,
      maxPositionPct: 0.25,
      maxGrossExposure: 1,
      maxConcurrentPositions: 4,
      maxOpenRisk: 0.02,
      dailyLossLimit: 0.05,
      flattenOnBreaker: false,
      micro: null,
    });
    expect(() => parseRunConfig(JSON.parse(JSON.stringify(deployed)))).not.toThrow();
    expect(() => holdoutConfig(EXPECTED, REGISTRATION.thresholds, { ...choice, exit: "C" })).toThrow(
      /not a variant/,
    );
  });
});

describe("the preconditions (section 3, Amendment 6)", () => {
  it("all hold for the pre-registered run from a clean commit with everything in place", () => {
    expect(preconditions(facts()).filter((c) => !c.passed)).toEqual([]);
  });

  const failing = (overrides: Partial<RunFacts>) =>
    preconditions(facts(overrides))
      .filter((c) => !c.passed)
      .map((c) => c.name);

  it("fail one at a time, each for its own reason", () => {
    expect(
      failing({ run: runRow({ config: { ...EXPECTED, universe: { ...EXPECTED.universe, topN: 19 } } }) }),
    ).toEqual(["the pre-registered run"]);
    expect(failing({ run: runRow({ blind: true, config: { ...EXPECTED, blind: true } }) })).toContain(
      "completed with outcomes",
    );
    expect(failing({ run: runRow({ status: "failed" }) })).toEqual(["completed with outcomes"]);
    expect(failing({ run: runRow({ gitDirty: true }) })).toEqual(["a clean commit"]);
    expect(failing({ run: runRow({ gitCommit: null }) })).toEqual(["a clean commit"]);
    expect(failing({ run: runRow({ registrationSha256: "f".repeat(64) }) })).toEqual(["this registration"]);
    expect(failing({ nullModel: undefined })).toEqual(["the null model on its commit"]);
    expect(failing({ nullModel: { ...passingNullModel, verdict: "fail" } })).toEqual([
      "the null model on its commit",
    ]);
    expect(failing({ etfListInCommit: false })).toEqual(["the ETF and ETN list in its commit"]);
    expect(failing({ run: runRow({ summary: { badTickFilter: "off" } as RunRow["summary"] }) })).toEqual([
      "the bad-tick filter",
    ]);
    expect(failing({ unrankable: { minutesNotLoaded: 1, baselineEmpty: 27 } })).toEqual([
      "no holes in the data",
    ]);
  });

  it("report nothing measured when one fails", () => {
    const report = inSampleReport({
      ...facts({ nullModel: undefined }),
      records: inSampleTrades(0.3),
      costModel: MODEL,
      asDeployed: null,
    });
    expect(report.result).toBeNull();
    const text = renderInSampleReport(report);
    expect(text).toContain(
      "| the null model on its commit | FAIL | not run on 01234567 (pnpm backtest null-model) |",
    );
    expect(text).toContain("No verdict: a precondition failed.");
    expect(text).not.toMatch(/Net mean R|Year by year/);
  });
});

describe("the in-sample report", () => {
  it("is NO EDGE when no exit passes, with nothing frozen, deployed, or to commit", () => {
    const report = inSampleReport({
      ...facts(),
      records: inSampleTrades(-0.2),
      costModel: MODEL,
      asDeployed: null,
    });
    expect(report.result?.outcome).toBe("NO EDGE");
    expect(report.result?.frozen).toBeNull();
    expect(report.result?.frozenConfiguration).toBeNull();
    expect(addendumBlock(report)).toBeNull();
    expect(renderInSampleReport(report)).toContain("Section 10: the project stops.");
  });

  it("is an EDGE CANDIDATE when an exit passes, and hands on the holdout run and the in-sample numbers", () => {
    const records = inSampleTrades(0.45);
    const report = inSampleReport({ ...facts(), records, costModel: MODEL, asDeployed: null });
    const result = report.result;
    expect(result?.outcome).toBe("EDGE CANDIDATE");
    // 8 years, 12 months, 11 sessions, 2 trades: 2,112 an exit. Top 10 holds the rank-3 half.
    expect(result?.exits.map((v) => [v.id, v.outcome, v.trades])).toEqual([
      ["A", "pass", 2_112],
      ["B", "pass", 2_112],
    ]);
    expect(result?.topTen.map((v) => [v.trades, v.outcome])).toEqual([
      [1_056, "insufficient"],
      [1_056, "insufficient"],
    ]);
    // Same trades on both exits here, so the same lower bound: the tie goes to A, and top 20 stands.
    expect(result?.frozen).toMatchObject({ exit: "A", topN: 20 });
    expect(result?.frozenInSample?.trades).toBe(2_112);
    expect(result?.diagnostics.costs.mismatch).toBeNull();
    expect(result?.diagnostics.costs.checked).toBe(2 * 2_112);

    // The block parses back as a registration addendum, and the frozen run then passes the guard.
    const block = addendumBlock(report) as string;
    const withAddendum = parseRegistration(
      `${readFileSync(REGISTRATION_PATH, "utf8")}\n### Addendum\n\n${block}\n`,
    );
    expect(withAddendum.frozenInSample).toMatchObject({
      runId: report.runId,
      commit: COMMIT,
      exit: "A",
      trades: result?.frozenInSample?.trades,
    });
    const frozen = withAddendum.frozen as NonNullable<Registration["frozen"]>;
    expect(() => checkRunAllowed(frozen, withAddendum, { commit: COMMIT, dirty: false })).not.toThrow();
    expect(() => checkRunAllowed(frozen, withAddendum, { commit: COMMIT, dirty: true })).toThrow();

    const text = renderInSampleReport(report);
    expect(text).toContain("## Verdict: EDGE CANDIDATE (the holdout decides)");
    expect(text).toContain("| Gate | Exit A | Exit B |");
    expect(text).toContain("| 2016 | 264 |");
    expect(text).toContain("H3: the gate passed");
    expect(text).toContain("Cost sensitivity");
    expect(text).toContain("```json");
    expect(text).not.toMatch(/[–—]/);
  });

  it("carries the as-deployed run's dollars, drawdown, and what the account turned away", () => {
    const choice = { exit: "A", topN: 20, reason: "" };
    const config = asDeployedConfig(EXPECTED, REGISTRATION.thresholds, choice);
    const records = [
      ...inSampleTrades(0.45, ["A"])
        .slice(0, 40)
        .map((t) => ({ ...t, shares: 1 })),
      {
        ...trade("A", "2016-02-10", "X", 1, 1),
        entryOutcome: "refused",
        refusal: "risk: MAX_CONCURRENT_POSITIONS",
      },
      { ...trade("A", "2016-02-10", "Y", 2, 1), entryOutcome: "refused", refusal: "sizing: BELOW_ONE_SHARE" },
      { ...trade("A", "2016-02-10", "Z", 3, 1), entryOutcome: "refused", refusal: "costToRisk: ABOVE_MAX" },
    ] as TradeRecord[];
    const deployed = asDeployedResult(runRow({ id: "d", config }), records, ["2016-01-11"]);
    expect(deployed).toMatchObject({ runId: "d", signals: 43, skipped: 2 });
    expect(deployed.metrics.equity.dailyDollars).not.toBeNull();
    expect(() => asDeployedResult(runRow(), records, [])).toThrow(/not an as-deployed run/);

    const report = inSampleReport({
      ...facts(),
      records: inSampleTrades(0.45),
      costModel: MODEL,
      asDeployed: deployed,
    });
    expect(report.result?.asDeployed?.skipped).toBe(2);
    expect(renderInSampleReport(report)).toContain("2 turned away by sizing or the risk rules");
  });
});

describe("the holdout report", () => {
  const choice = { exit: "A", topN: 20, reason: "" };
  const frozen = holdoutConfig(EXPECTED, REGISTRATION.thresholds, choice);
  const withInSample = (netMeanR: number): Registration => ({
    ...REGISTRATION,
    frozen,
    frozenInSample: {
      runId: "4f0c0f0e-0000-4000-8000-000000000001",
      commit: COMMIT,
      exit: "A",
      topN: 20,
      trades: 2_112,
      netMeanR,
    },
  });
  const holdoutTrades = inSampleTrades(0.45, ["A"]).map((t) => ({
    ...t,
    session: `2024${t.session.slice(4)}`,
  }));

  it("is EDGE when the holdout is positive and not worse than in-sample", () => {
    const registration = withInSample(0.3);
    const report = holdoutReport({
      ...facts({ run: runRow({ config: frozen }), expected: frozen, registration }),
      records: holdoutTrades,
    });
    expect(report.result?.outcome).toBe("EDGE");
    expect(renderHoldoutReport(report)).toContain("Section 6: EDGE.");
  });

  it("is NO EDGE when the in-sample mean towers over the holdout, and refuses without the committed numbers", () => {
    const report = holdoutReport({
      ...facts({ run: runRow({ config: frozen }), expected: frozen, registration: withInSample(5) }),
      records: holdoutTrades,
    });
    expect(report.result?.outcome).toBe("NO EDGE");
    expect(report.result?.verdict.gates.notWorse.passed).toBe(false);
    const none = holdoutReport({
      ...facts({
        run: runRow({ config: frozen }),
        expected: frozen,
        registration: { ...withInSample(0.3), frozenInSample: null },
      }),
      records: holdoutTrades,
    });
    expect(none.result).toBeNull();
    expect(renderHoldoutReport(none)).toContain("| the in-sample numbers committed | FAIL |");
  });
});
