import type { Fixed } from "@trader/contracts";
import { createRng } from "@trader/core";
import { describe, expect, it } from "vitest";
import { loadRound2 } from "../round2.js";
import type { Gapper } from "./signals.js";
import { type PricedTrade, judge, netMillionths, pick, underPriceTest } from "./study.js";

const gapper = (symbol: string, gap: number, news = 0, session = "2019-05-14"): Gapper => ({
  symbol,
  session,
  gap,
  news,
  priorClose: 200_000 as Fixed,
  dailyAtr: 10_000 as Fixed,
  averageVolume: 2_000_000,
  premarket: { price: Math.round(200_000 * (1 + gap)) as Fixed, volume: 10_000, asOf: 0 },
});

describe("picking a session's trades", () => {
  const gappers = [
    gapper("AAA", 0.08),
    gapper("BBB", 0.03),
    gapper("CCC", 0.12, 2),
    gapper("DDD", 0.05),
    gapper("EEE", 0.029),
    gapper("FFF", 0.05),
    gapper("GGG", -0.06),
    gapper("HHH", 0.2),
  ];

  it("takes quiet gap-ups at or over the minimum, not under the price test, largest first, top N", () => {
    const picked = pick(gappers, { minGap: 0.03, topN: 3 }, new Set(["HHH"]));
    // HHH is restricted, CCC had news, EEE is under the minimum; DDD and FFF tie and go by symbol.
    expect(picked.map((g) => g.symbol)).toEqual(["AAA", "DDD", "FFF"]);
    expect(pick(gappers, { minGap: 0.03, topN: 10 }, new Set()).map((g) => g.symbol)).toEqual([
      "HHH",
      "AAA",
      "DDD",
      "FFF",
      "BBB",
    ]);
  });

  it("reads the mirror side and the news side for the diagnostics", () => {
    expect(pick(gappers, { minGap: 0.03, topN: 3 }, new Set(), "down").map((g) => g.symbol)).toEqual(["GGG"]);
    expect(pick(gappers, { minGap: 0.03, topN: 3 }, new Set(), "up", "news").map((g) => g.symbol)).toEqual([
      "CCC",
    ]);
  });
});

describe("the short-sale price test", () => {
  it("is on when the prior session's low fell at least 10% under the close before it", () => {
    expect(underPriceTest(90, 100, 0.1)).toBe(true);
    expect(underPriceTest(90.01, 100, 0.1)).toBe(false);
  });
});

describe("a trade's net return", () => {
  it("is the open less the close over the open for a short, less the sale fee, in millionths", () => {
    // Short at 20.00, cover at 19.80: 1% = 10,000 millionths, less 0.5 bps = 50.
    expect(netMillionths("short", 20, 19.8, 0.5)).toBe(9_950);
    expect(netMillionths("long", 20, 19.8, 0.5)).toBe(-10_050);
    expect(netMillionths("short", 20, 20, 0)).toBe(0);
  });
});

describe("judging the study", async () => {
  const { round } = await loadRound2();
  const rng = createRng(3);
  // Three trades a session, three sessions a month, every in-sample year, with an edge of `bps`.
  const trades = (bps: number): PricedTrade[] =>
    Array.from({ length: 8 }, (_, y) => 2016 + y).flatMap((year) =>
      Array.from({ length: 36 }, (_, d) => {
        const session = `${String(year)}-${String(1 + Math.floor(d / 3)).padStart(2, "0")}-${String(10 + (d % 3))}`;
        return ["A", "B", "C"].map((symbol) => {
          const net = Math.round((bps / 10_000 + (rng.next() - 0.5) * 0.04) * 1_000_000);
          return { symbol, session, gap: 0.04 + rng.next() * 0.1, open: null, close: null, net };
        });
      }).flat(),
    );

  it("passes a clear edge at the study's alpha and fails none, counting unpriced trades apart", () => {
    const withMissing = [
      ...trades(40),
      { symbol: "X", session: "2019-03-10", gap: 0.05, open: null, close: null, net: null },
    ];
    const result = judge({
      round,
      minTrades: 500,
      trades: withMissing,
      withNews: [],
      gapDowns: [],
      daily: () => null,
    });
    expect(result.unpriced).toBe(1);
    expect(result.priced).toBe(8 * 36 * 3);
    expect(result.verdict.outcome).toBe("pass");
    expect(result.verdict.holm?.threshold).toBe(0.01);
    expect(result.diagnostics.byGap.reduce((n, b) => n + b.estimate.trades, 0)).toBe(result.priced);
    expect(
      judge({ round, minTrades: 500, trades: trades(-5), withNews: [], gapDowns: [], daily: () => null })
        .verdict.outcome,
    ).toBe("fail");
    expect(
      judge({ round, minTrades: 5_000, trades: trades(40), withNews: [], gapDowns: [], daily: () => null })
        .verdict.outcome,
    ).toBe("insufficient");
  });

  it("prices the diagnostics from the day's own bar", () => {
    const result = judge({
      round,
      minTrades: 1,
      trades: [],
      withNews: [gapper("N", 0.05, 1)],
      gapDowns: [gapper("D", -0.05), gapper("E", -0.05)],
      daily: (symbol) => (symbol === "E" ? null : { open: 20, close: 19.8 }),
    });
    expect(result.diagnostics.withNews).toMatchObject({ trades: 1, meanBps: 99.5 });
    expect(result.diagnostics.gapDownLong).toMatchObject({ trades: 1, meanBps: -100.5 });
  });
});
