import { describe, expect, it } from "vitest";
import { diffRuns } from "./diff.js";
import type { RunSummary } from "./run.js";
import type { RunRow } from "./store.js";
import { testConfig } from "./testing.js";

const summary: RunSummary = {
  blind: false,
  sessions: 5,
  bars: 1_000,
  elapsedMs: 1_500,
  excludedSessions: [],
  excludedSymbols: 0,
  badTickFilter: "on",
  corruptSessions: 0,
  eligible: 60,
  inPlay: 60,
  unrankable: 0,
  signals: 30,
  gatePassed: { A: 20, B: 20 },
  outcomes: {
    badTicks: 0,
    closedAtSessionEnd: 0,
    expiredEntries: 0,
    unloaded: 0,
    byVariant: [
      {
        variant: "A",
        direction: "long",
        signals: 30,
        gatePassed: 20,
        filled: 12,
        meanNetR: -1_000 as never,
        meanGrossR: 500 as never,
        byYear: [{ year: 2026, trades: 12, meanNetR: -1_000 as never, totalNetR: -12_000 }],
      },
    ],
  },
};

const row = (overrides: Partial<RunRow> = {}): RunRow => ({
  id: "a",
  name: "run",
  status: "completed",
  blind: false,
  config: testConfig(),
  gitCommit: "0123456789abcdef",
  gitDirty: false,
  registrationVersion: 4,
  registrationSha256: "f".repeat(64),
  dataSnapshot: { id: "1234567890abcdef", facts: {} },
  progress: null,
  summary,
  error: null,
  createdAt: new Date("2026-09-24T00:00:00Z"),
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

describe("diffing two runs (L.5)", () => {
  it("says so when they ran the same thing on the same code and data, and got the same result", () => {
    const lines = diffRuns(row(), row({ id: "b", name: "again", summary: { ...summary, elapsedMs: 9_000 } }));
    expect(lines).toEqual([
      "a: a run (completed)",
      "b: b again (completed)",
      "commit: same (01234567)",
      "data snapshot: same (1234567890abcdef)",
      "registration: same (v4 ffffffff)",
      "config: identical",
      "results: identical",
      "time: 1.5 s -> 9.0 s",
    ]);
  });

  it("names every configuration field and result that moved, with the change, and R as R", () => {
    const b = row({
      id: "b",
      gitCommit: "fedcba9876543210",
      gitDirty: true,
      dataSnapshot: { id: "aaaaaaaaaaaaaaaa", facts: {} },
      config: testConfig({ universe: { ...testConfig().universe, topN: 10 }, shorts: false }),
      summary: {
        ...summary,
        signals: 28,
        outcomes: {
          ...(summary.outcomes as NonNullable<RunSummary["outcomes"]>),
          byVariant: [
            {
              ...(summary.outcomes?.byVariant[0] as NonNullable<RunSummary["outcomes"]>["byVariant"][number]),
              meanNetR: -800 as never,
            },
          ],
        },
      },
    });
    const lines = diffRuns(row(), b);
    expect(lines).toContain("commit: 01234567 -> fedcba98+dirty");
    expect(lines).toContain("data snapshot: 1234567890abcdef -> aaaaaaaaaaaaaaaa");
    expect(lines).toContain("config: 2 differences");
    expect(lines).toContain("  shorts: true -> false");
    expect(lines).toContain("  universe.topN: 20 -> 10 (-10)");
    expect(lines).toContain("results: 2 differences");
    expect(lines).toContain("  outcomes.byVariant.A long.meanNetR: -0.1000R -> -0.0800R (+0.0200R)");
    expect(lines).toContain("  signals: 30 -> 28 (-2)");
  });

  it("keys variants and years by what they are, so an added one is one difference", () => {
    const outcomes = summary.outcomes as NonNullable<RunSummary["outcomes"]>;
    const first = outcomes.byVariant[0] as NonNullable<RunSummary["outcomes"]>["byVariant"][number];
    const b = row({
      summary: {
        ...summary,
        outcomes: { ...outcomes, byVariant: [{ ...first, variant: "B", filled: 3 }, first] },
      },
    });
    const lines = diffRuns(row(), b);
    expect(lines.filter((l) => l.includes("A long"))).toEqual([]);
    expect(lines).toContain("  outcomes.byVariant.B long.filled: (none) -> 3");
  });

  it("compares a long list as a set, in one line", () => {
    const universe = testConfig().universe;
    const list = (n: number) => Array.from({ length: n }, (_, i) => `ETF${String(i)}`);
    const a = row({ config: testConfig({ universe: { ...universe, excludeSymbols: list(30) } }) });
    const b = row({
      config: testConfig({
        universe: { ...universe, excludeSymbols: [...list(29), { symbol: "FB", from: "2025-06-26" }] },
      }),
    });
    const lines = diffRuns(a, b);
    expect(lines).toContain("config: 1 differences");
    expect(lines).toContain(
      '  universe.excludeSymbols: 30 -> 30 entries, 1 added ({"from":"2025-06-26","symbol":"FB"}), 1 removed ("ETF29")',
    );
    expect(diffRuns(a, a)).toContain("config: identical");
  });

  it("says which run has no results yet", () => {
    expect(diffRuns(row(), row({ status: "running", summary: null })).at(-1)).toBe(
      "results: b has none (running)",
    );
  });
});
