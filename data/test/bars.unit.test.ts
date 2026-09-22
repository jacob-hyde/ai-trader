import { type AlpacaAsset, type AlpacaBar, AlpacaClient } from "@trader/adapters/alpaca";
import { describe, expect, it } from "vitest";
import { type DailyRow, toDailyRow, toMinuteRow, units } from "../src/bars/convert.js";
import { planJobs } from "../src/bars/loader.js";
import { InvalidSymbolError, alpacaSource } from "../src/bars/source.js";
import { fromAssets, fromCorporateActions, fromFile, isTicker } from "../src/bars/symbols.js";
import {
  monthOf,
  monthsBetween,
  newYorkDate,
  newYorkOffsetMinutes,
  newYorkToUtc,
  nextMonth,
  previousMonth,
  sessionTimes,
} from "../src/bars/time.js";
import { PUBLISHED_SCREEN, eligibleSessions, monthsToLoad } from "../src/bars/universe.js";

const SESSIONS = new Map(
  [
    { date: "2021-01-27", open: "09:30", close: "16:00" },
    { date: "2021-03-15", open: "09:30", close: "16:00" },
    { date: "2021-11-26", open: "09:30", close: "13:00" },
  ].map((day) => [day.date, sessionTimes(day)]),
);

function bar(t: string, price = 100, overrides: Partial<AlpacaBar> = {}): AlpacaBar {
  return { t, o: price, h: price + 1, l: price - 1, c: price, v: 1_000, n: 10, vw: price, ...overrides };
}

describe("New York time", () => {
  it("knows daylight time from standard time, on either side of both changes", () => {
    expect(newYorkOffsetMinutes("2021-03-12")).toBe(300);
    expect(newYorkOffsetMinutes("2021-03-15")).toBe(240);
    expect(newYorkOffsetMinutes("2021-11-05")).toBe(240);
    expect(newYorkOffsetMinutes("2021-11-08")).toBe(300);
  });

  it("turns wall-clock opens and closes into UTC, half days included", () => {
    expect(newYorkToUtc("2021-01-27", "09:30").toISOString()).toBe("2021-01-27T14:30:00.000Z");
    expect(newYorkToUtc("2021-03-15", "09:30").toISOString()).toBe("2021-03-15T13:30:00.000Z");
    expect(sessionTimes({ date: "2021-11-26", open: "09:30", close: "13:00" })).toEqual({
      session: "2021-11-26",
      openAt: Date.parse("2021-11-26T14:30:00Z"),
      closeAt: Date.parse("2021-11-26T18:00:00Z"),
    });
  });

  it("dates an instant in New York, where a daily bar's midnight stamp belongs", () => {
    expect(newYorkDate(new Date("2021-06-01T04:00:00Z"))).toBe("2021-06-01");
    expect(newYorkDate(new Date("2021-01-27T05:00:00Z"))).toBe("2021-01-27");
    expect(newYorkDate(new Date("2021-01-28T02:00:00Z"))).toBe("2021-01-27");
  });

  it("walks months", () => {
    expect(monthOf("2021-06-17")).toBe("2021-06-01");
    expect(monthOf("2021-06")).toBe("2021-06-01");
    expect(() => monthOf("June")).toThrow(RangeError);
    expect(nextMonth("2021-12-01")).toBe("2022-01-01");
    expect(previousMonth("2021-01-01")).toBe("2020-12-01");
    expect(monthsBetween("2020-11-15", "2021-02")).toEqual([
      "2020-11-01",
      "2020-12-01",
      "2021-01-01",
      "2021-02-01",
    ]);
  });
});

describe("converting bars", () => {
  it("turns prices into exact units of $0.0001", () => {
    expect(units(338.3699)).toBe(3_383_699);
    expect(units(86.8775)).toBe(868_775);
    expect(units(0.0001)).toBe(1);
    expect(units(338.301671)).toBe(3_383_017);
    expect(units(0)).toBeNull();
    expect(units(-1)).toBeNull();
    expect(units(Number.NaN)).toBeNull();
  });

  it("places a minute bar in its session and drops pre- and after-market", () => {
    expect(toMinuteRow("GME", bar("2021-01-27T14:30:00Z"), SESSIONS)).toMatchObject({
      session: "2021-01-27",
      minute: 0,
      ts: "2021-01-27T14:30:00.000Z",
      open: 1_000_000,
      high: 1_010_000,
      vwap: 1_000_000,
    });
    expect(toMinuteRow("GME", bar("2021-01-27T20:59:00Z"), SESSIONS)).toMatchObject({ minute: 389 });
    expect(toMinuteRow("GME", bar("2021-01-27T21:00:00Z"), SESSIONS)).toBe("outsideSession");
    expect(toMinuteRow("GME", bar("2021-01-27T13:00:00Z"), SESSIONS)).toBe("outsideSession");
    // Daylight time moves the open to 13:30Z.
    expect(toMinuteRow("GME", bar("2021-03-15T13:30:00Z"), SESSIONS)).toMatchObject({ minute: 0 });
    // A half day ends at 13:00 ET.
    expect(toMinuteRow("GME", bar("2021-11-26T17:59:00Z"), SESSIONS)).toMatchObject({ minute: 209 });
    expect(toMinuteRow("GME", bar("2021-11-26T18:00:00Z"), SESSIONS)).toBe("outsideSession");
    // No session that day.
    expect(toMinuteRow("GME", bar("2021-01-30T15:00:00Z"), SESSIONS)).toBe("outsideSession");
  });

  it("drops a bar whose prices contradict each other, or that is off the minute", () => {
    expect(toMinuteRow("X", bar("2021-01-27T15:00:00Z", 100, { h: 99 }), SESSIONS)).toBe("invalid");
    expect(toMinuteRow("X", bar("2021-01-27T15:00:00Z", 100, { l: 101 }), SESSIONS)).toBe("invalid");
    expect(toMinuteRow("X", bar("2021-01-27T15:00:00Z", 100, { o: 0 }), SESSIONS)).toBe("invalid");
    expect(toMinuteRow("X", bar("2021-01-27T15:00:30Z"), SESSIONS)).toBe("invalid");
    expect(toMinuteRow("X", bar("2021-01-27T15:00:00Z", 100, { n: null, vw: null }), SESSIONS)).toMatchObject(
      {
        trades: null,
        vwap: null,
      },
    );
  });

  it("gives a daily bar its session and its split factor from the adjusted volume", () => {
    const raw = bar("2021-01-27T05:00:00Z", 347.51, { v: 93_561_451 });
    expect(toDailyRow("GME", raw, 374_245_804, SESSIONS)).toMatchObject({
      session: "2021-01-27",
      close: 3_475_100,
      volume: 93_561_451,
      splitFactor: 4,
    });
    expect(toDailyRow("GME", raw, undefined, SESSIONS)).toMatchObject({ splitFactor: null });
    expect(toDailyRow("GME", { ...raw, v: 0 }, 0, SESSIONS)).toMatchObject({ splitFactor: null });
    expect(toDailyRow("GME", bar("2021-01-30T05:00:00Z"), 1, SESSIONS)).toBe("outsideSession");
    expect(toDailyRow("GME", { ...raw, h: 1 }, 1, SESSIONS)).toBe("invalid");
  });
});

describe("the ticker list", () => {
  const asset = (symbol: string, status: "active" | "inactive", overrides: Partial<AlpacaAsset> = {}) =>
    ({
      id: "x",
      class: "us_equity",
      exchange: "NASDAQ",
      symbol,
      name: symbol,
      status,
      tradable: status === "active",
      marginable: false,
      shortable: false,
      easy_to_borrow: false,
      fractionable: false,
      attributes: null,
      ...overrides,
    }) as AlpacaAsset;

  it("takes exchange and OTC tickers from the asset list, labelled by status", () => {
    expect(
      fromAssets([
        asset("AAPL", "active"),
        asset("XLNX", "inactive"),
        asset("SBNY", "active", { exchange: "OTC" }),
        asset("BTC/USD", "active"),
        asset("ODD", "active", { class: "crypto" }),
      ]),
    ).toEqual([
      { symbol: "AAPL", source: "asset:active" },
      { symbol: "XLNX", source: "asset:inactive" },
      { symbol: "SBNY", source: "asset:active" },
    ]);
  });

  it("takes acquirees, both sides of a name change, and worthless removals from corporate actions", () => {
    expect(
      fromCorporateActions({
        cash_mergers: [
          {
            acquiree_symbol: "TWTR",
            acquirer_symbol: null,
            effective_date: "2022-10-28",
            process_date: null,
          },
        ],
        stock_mergers: [
          { acquiree_symbol: "XLNX", acquirer_symbol: "AMD", effective_date: null, process_date: null },
        ],
        stock_and_cash_mergers: [],
        name_changes: [{ old_symbol: "FB", new_symbol: "META", process_date: "2022-06-09" }],
        worthless_removals: [
          { symbol: "SIVBQ", process_date: null },
          { symbol: "12345Z", process_date: null },
        ],
      }),
    ).toEqual([
      { symbol: "TWTR", source: "merger" },
      { symbol: "XLNX", source: "merger" },
      { symbol: "FB", source: "nameChange" },
      { symbol: "META", source: "nameChange" },
      { symbol: "SIVBQ", source: "worthless" },
    ]);
  });

  it("reads a file of extra tickers, one a line, comments and junk ignored", () => {
    expect(
      fromFile("SIVB\n  frc  # First Republic\n\n# a comment\nnot a ticker\nBRK.B\n", "extra.txt"),
    ).toEqual([
      { symbol: "SIVB", source: "file:extra.txt" },
      { symbol: "FRC", source: "file:extra.txt" },
      { symbol: "BRK.B", source: "file:extra.txt" },
    ]);
    expect(isTicker("TOOLONGTICKER")).toBe(false);
  });
});

/** A daily history: 30 sessions of a $20 stock trading 2M shares with a $1 range, unless changed. */
function history(length = 30, change: (i: number, row: DailyRow) => DailyRow = (_i, row) => row): DailyRow[] {
  return Array.from({ length }, (_unused, i) => {
    const session = new Date(Date.UTC(2021, 0, 4 + i)).toISOString().slice(0, 10);
    const row: DailyRow = {
      symbol: "X",
      session,
      open: 200_000,
      high: 205_000,
      low: 195_000,
      close: 200_000,
      volume: 2_000_000,
      trades: null,
      vwap: null,
      splitFactor: 1,
    };
    return change(i, row);
  });
}

describe("the liquidity screen", () => {
  it("needs a full lookback before judging, then passes a liquid, volatile $20 name every session", () => {
    const eligible = eligibleSessions(history(), PUBLISHED_SCREEN);
    expect(eligible).toHaveLength(16);
    expect(eligible[0]).toBe(history()[14]?.session);
  });

  it("judges a session on the bars before it only: its own bar cannot move the answer", () => {
    const base = eligibleSessions(history(), PUBLISHED_SCREEN);
    const wild = history(30, (i, row) =>
      i === 20 ? { ...row, close: 5_000_000, high: 5_000_000, volume: 1 } : row,
    );
    // The wild bar leaves its own session alone; the sessions after it see it and drop out on price.
    expect(eligibleSessions(wild, PUBLISHED_SCREEN).slice(0, 7)).toEqual(base.slice(0, 7));
    expect(eligibleSessions(wild, PUBLISHED_SCREEN)).not.toContain(history()[21]?.session);
  });

  it("applies each threshold, strictly where the strategy is strict", () => {
    const cases: Array<[string, (row: DailyRow) => DailyRow, number]> = [
      [
        "price above $100",
        (row) => ({ ...row, open: 1_200_000, high: 1_205_000, low: 1_195_000, close: 1_200_000 }),
        0,
      ],
      ["price under $5", (row) => ({ ...row, open: 40_000, high: 50_000, low: 30_000, close: 40_000 }), 0],
      ["volume at exactly 1M", (row) => ({ ...row, volume: 1_000_000 }), 0],
      ["range of exactly $0.50", (row) => ({ ...row, high: 202_500, low: 197_500 }), 0],
      [
        "price at exactly $100",
        (row) => ({ ...row, open: 1_000_000, high: 1_005_000, low: 995_000, close: 1_000_000 }),
        16,
      ],
    ];
    for (const [what, change, expected] of cases) {
      expect(
        eligibleSessions(
          history(30, (_i, row) => change(row)),
          PUBLISHED_SCREEN,
        ),
        what,
      ).toHaveLength(expected);
    }
  });

  it("sees through a split inside the lookback, as a scanner that morning would", () => {
    // A $400 stock splits 20:1 at session 10 and trades at $20 after. Before the split, each old share is
    // 20 of today's, so its factor is 20 and it looks like the unsplit $20 history once adjusted.
    const split = history(30, (i, row) =>
      i < 10
        ? {
            ...row,
            open: row.open * 20,
            high: row.high * 20,
            low: row.low * 20,
            close: row.close * 20,
            volume: row.volume / 20,
            splitFactor: 20,
          }
        : row,
    );
    expect(eligibleSessions(split, PUBLISHED_SCREEN)).toEqual(eligibleSessions(history(), PUBLISHED_SCREEN));
    // Without the factors the split reads as a $400 stock with a $380 crash in its ATR.
    const blind = split.map((row) => ({ ...row, splitFactor: null }));
    expect(eligibleSessions(blind, PUBLISHED_SCREEN)).not.toEqual(
      eligibleSessions(history(), PUBLISHED_SCREEN),
    );
  });

  it("loads each month with an eligible session and the month before it, for the RVOL lookback", () => {
    expect(monthsToLoad(["2021-03-02", "2021-03-19", "2021-06-01"])).toEqual([
      "2021-02-01",
      "2021-03-01",
      "2021-05-01",
      "2021-06-01",
    ]);
    expect(monthsToLoad([])).toEqual([]);
  });
});

describe("planning jobs", () => {
  it("batches daily symbols that need the same span, and splits a batch at the size", () => {
    const units = [
      ...["A", "B", "C"].flatMap((symbol) =>
        ["2021-01-01", "2021-02-01"].map((month) => ({ symbol, month })),
      ),
      { symbol: "D", month: "2021-02-01" },
    ];
    const jobs = planJobs("1Day", units, 2);
    expect(jobs.map((job) => [job.symbols, job.fromMonth, job.untilMonth])).toEqual([
      [["A", "B"], "2021-01-01", "2021-03-01"],
      [["C"], "2021-01-01", "2021-03-01"],
      [["D"], "2021-02-01", "2021-03-01"],
    ]);
    expect([...(jobs[0]?.units ?? [])]).toEqual([
      "A|2021-01-01",
      "A|2021-02-01",
      "B|2021-01-01",
      "B|2021-02-01",
    ]);
  });

  it("runs minute bars a month at a time, a few symbols per job", () => {
    const units = [
      { symbol: "B", month: "2021-02-01" },
      { symbol: "A", month: "2021-02-01" },
      { symbol: "A", month: "2021-01-01" },
    ];
    expect(planJobs("1Min", units, 8).map((job) => [job.symbols, job.fromMonth, job.untilMonth])).toEqual([
      [["A"], "2021-01-01", "2021-02-01"],
      [["A", "B"], "2021-02-01", "2021-03-01"],
    ]);
  });
});

describe("the Alpaca source", () => {
  const source = (status: number, message: string) =>
    alpacaSource(
      new AlpacaClient({
        keyId: "k",
        secretKey: "s",
        tradingUrl: "https://paper-api.example",
        maxAttempts: 1,
        fetch: (() => Promise.resolve(new Response(JSON.stringify({ message }), { status }))) as typeof fetch,
      }),
    );
  const read = async (s: ReturnType<typeof source>) => {
    const query = {
      timeframe: "1Day",
      symbols: ["A"],
      start: "2021-01-01",
      end: "2021-02-01",
      adjustment: "raw",
    } as const;
    for await (const _page of s.bars(query)) {
      // Every request here fails before a page arrives.
    }
  };

  it("names the symbol Alpaca refused, so the loader can drop it", async () => {
    const error = await read(source(400, "invalid symbol: B002455")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidSymbolError);
    expect((error as InvalidSymbolError).symbol).toBe("B002455");
  });

  it("lets every other failure through as it was", async () => {
    await expect(read(source(400, "invalid timeframe"))).rejects.not.toBeInstanceOf(InvalidSymbolError);
    await expect(read(source(403, "invalid symbol: X"))).rejects.toThrow("403");
  });
});
