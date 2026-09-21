import fc from "fast-check";
import { describe, expect, it } from "vitest";
import reference from "./__fixtures__/indicators.reference.json" with { type: "json" };
import { isBarAfter, isWellFormedBar, type Bar } from "./bars.js";
import {
  Atr,
  DEFAULT_RELATIVE_VOLUME,
  IndicatorError,
  RelativeVolume,
  Rsi,
  SessionVwap,
} from "./indicators.js";
import { fixed, fromNumber, type Fixed } from "./money.js";

const usd = fromNumber;

function bar(session: string, minuteOfSession: number, overrides: Partial<Bar> = {}): Bar {
  return {
    session,
    minuteOfSession,
    open: usd(20),
    high: usd(20.1),
    low: usd(19.9),
    close: usd(20.05),
    volume: 1_000,
    vwap: null,
    closed: true,
    ...overrides,
  };
}

const referenceBars: readonly Bar[] = reference.bars.map((raw) => ({
  session: raw.session,
  minuteOfSession: raw.minuteOfSession,
  open: fixed(raw.open),
  high: fixed(raw.high),
  low: fixed(raw.low),
  close: fixed(raw.close),
  volume: raw.volume,
  vwap: raw.vwap === null ? null : fixed(raw.vwap),
  closed: true,
}));

function indicatorSet() {
  const set = { atr: new Atr(), rsi: new Rsi(), vwap: new SessionVwap(), rvol: new RelativeVolume() };
  return {
    ...set,
    update: (next: Bar) => [set.atr, set.rsi, set.vwap, set.rvol].map((indicator) => indicator.update(next)),
    snapshot: () => ({
      atr: set.atr.value,
      rsi: set.rsi.value,
      vwap: set.vwap.value,
      running: set.rvol.running,
      opening: set.rvol.opening,
      warm: [set.atr.warmedUp, set.rsi.warmedUp, set.vwap.warmedUp, set.rvol.warmedUp],
    }),
  };
}

function snapshotsOf(bars: readonly Bar[]) {
  const set = indicatorSet();
  return bars.map((next) => {
    set.update(next);
    return set.snapshot();
  });
}

describe("indicators against the independent reference", () => {
  const snapshots = snapshotsOf(referenceBars);

  it("uses the reference's parameters", () => {
    expect(new Atr().period).toBe(reference.period);
    expect(new Rsi().period).toBe(reference.period);
    expect(DEFAULT_RELATIVE_VOLUME).toEqual({
      baselineSessions: reference.baselineSessions,
      openingMinutes: reference.openingMinutes,
    });
  });

  it("matches ATR to within rounding and is null exactly while the reference is", () => {
    snapshots.forEach((snapshot, i) => {
      const expected = reference.atr[i] ?? null;
      if (expected === null) {
        expect(snapshot.atr, `bar ${i}`).toBeNull();
      } else {
        expect(Math.abs((snapshot.atr as Fixed) - expected), `bar ${i}`).toBeLessThanOrEqual(0.5 + 1e-6);
      }
      expect(snapshot.warm[0], `bar ${i}`).toBe(expected !== null);
    });
    expect(reference.atr.findIndex((value) => value !== null)).toBe(reference.period - 1);
  });

  it("matches RSI and is null exactly while the reference is", () => {
    snapshots.forEach((snapshot, i) => {
      const expected = reference.rsi[i] ?? null;
      if (expected === null) {
        expect(snapshot.rsi, `bar ${i}`).toBeNull();
      } else {
        expect(snapshot.rsi as number, `bar ${i}`).toBeCloseTo(expected, 9);
      }
      expect(snapshot.warm[1], `bar ${i}`).toBe(expected !== null);
    });
    expect(reference.rsi.findIndex((value) => value !== null)).toBe(reference.period);
  });

  it("matches session VWAP exactly", () => {
    snapshots.forEach((snapshot, i) => {
      expect(snapshot.vwap, `bar ${i}`).toBe(reference.vwap[i] ?? null);
      expect(snapshot.warm[2], `bar ${i}`).toBe(snapshot.vwap !== null);
    });
  });

  it("matches running and opening RVOL exactly", () => {
    snapshots.forEach((snapshot, i) => {
      expect(snapshot.running, `bar ${i} running`).toBe(reference.rvolRunning[i] ?? null);
      expect(snapshot.opening, `bar ${i} opening`).toBe(reference.rvolOpening[i] ?? null);
    });
    expect(reference.rvolRunning.filter((value) => value !== null).length).toBeGreaterThan(15);
    expect(reference.rvolOpening.filter((value) => value !== null).length).toBeGreaterThan(5);
  });
});

describe("Rsi against published values", () => {
  it("reproduces the StockCharts ChartSchool 14-period example", () => {
    const closes = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931,
      46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137,
      46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
    ];
    const published = [
      70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87,
      45.46, 37.3, 33.08, 37.77,
    ];
    const rsi = new Rsi(14);
    const values: number[] = [];
    closes.forEach((close, minute) => {
      const price = usd(close);
      rsi.update(bar("2026-01-05", minute, { open: price, high: price, low: price, close: price }));
      if (rsi.value !== null) {
        values.push(Math.round(rsi.value * 100) / 100);
      }
    });
    expect(values).toEqual(published);
  });

  it("reads 100 when nothing has closed lower", () => {
    const rsi = new Rsi(3);
    [20, 20.1, 20.2, 20.3].forEach((close, minute) => {
      const price = usd(close);
      rsi.update(bar("2026-01-05", minute, { open: price, high: price, low: price, close: price }));
    });
    expect(rsi.value).toBe(100);
  });
});

describe("bars an indicator must ignore", () => {
  const warm = referenceBars.slice(0, 124);
  const next = referenceBars[124] as Bar;

  function ignored(candidate: Bar, outcome: string): void {
    const set = indicatorSet();
    warm.forEach(set.update);
    const before = set.snapshot();
    expect(set.update(candidate)).toEqual([outcome, outcome, outcome, outcome]);
    expect(set.snapshot()).toEqual(before);
    // The ignored bar did not advance the clock either: the real next bar still applies.
    expect(set.update(next)).toEqual(["applied", "applied", "applied", "applied"]);
  }

  it("leaves every value unchanged for a bar that is still forming", () => {
    ignored({ ...next, closed: false, high: usd(500), close: usd(400), volume: 9_000_000 }, "partial");
  });

  it("gives the same values with partial bars interleaved as without them", () => {
    const interleaved = referenceBars.flatMap((closedBar) => [
      { ...closedBar, closed: false, close: closedBar.high, volume: closedBar.volume * 3 },
      closedBar,
    ]);
    const closedOnly = snapshotsOf(interleaved).filter((_, i) => i % 2 === 1);
    expect(closedOnly).toEqual(snapshotsOf(referenceBars));
  });

  it("leaves every value unchanged for a malformed bar", () => {
    const malformed: readonly Partial<Bar>[] = [
      { session: "" },
      { minuteOfSession: -1 },
      { minuteOfSession: 1.5 },
      { minuteOfSession: 1_440 },
      { open: usd(0) },
      { close: Number.NaN as Fixed },
      { high: usd(20) },
      { low: usd(20.06) },
      { volume: -1 },
      { volume: 0.5 },
      { vwap: usd(0) },
    ];
    for (const overrides of malformed) {
      const candidate = { ...bar(next.session, next.minuteOfSession), ...overrides };
      expect(isWellFormedBar(candidate), JSON.stringify(overrides)).toBe(false);
      ignored(candidate, "invalid");
    }
  });

  it("leaves every value unchanged for a replayed or out-of-order bar", () => {
    const last = warm.at(-1) as Bar;
    ignored(last, "stale");
    ignored({ ...last, minuteOfSession: last.minuteOfSession - 1 }, "stale");
    ignored({ ...last, session: "2025-12-31", minuteOfSession: 300 }, "stale");
  });
});

describe("no look-ahead", () => {
  it("never changes a value when the bars after it are shuffled", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: referenceBars.length - 1 }),
        fc.array(fc.nat(), { minLength: referenceBars.length, maxLength: referenceBars.length }),
        (cut, keys) => {
          // Future bars trade contents at random but keep their slots, so none of them is stale.
          const future = referenceBars.slice(cut);
          const order = future.map((_, i) => i).sort((a, b) => (keys[a] as number) - (keys[b] as number));
          const shuffled = future.map((slot, i) => {
            const source = future[order[i] as number] as Bar;
            return { ...source, session: slot.session, minuteOfSession: slot.minuteOfSession };
          });
          const original = snapshotsOf(referenceBars).slice(0, cut);
          const altered = snapshotsOf([...referenceBars.slice(0, cut), ...shuffled]).slice(0, cut);
          expect(altered).toEqual(original);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("SessionVwap", () => {
  it("prefers the bar's own vwap and falls back to the typical price", () => {
    const vwap = new SessionVwap();
    vwap.update(bar("2026-01-05", 0, { vwap: usd(20.02), volume: 100 }));
    expect(vwap.value).toBe(usd(20.02));
    // Typical price of the default bar is (20.10 + 19.90 + 20.05) / 3 = 20.01666..., weight 300 of 400.
    vwap.update(bar("2026-01-05", 1, { volume: 300 }));
    expect(vwap.value).toBe(usd(20.0175));
  });

  it("resets on the first bar of a new session", () => {
    const vwap = new SessionVwap();
    vwap.update(bar("2026-01-05", 0, { vwap: usd(30), volume: 5_000 }));
    vwap.update(bar("2026-01-06", 0, { vwap: usd(20), volume: 10 }));
    expect(vwap.value).toBe(usd(20));
  });

  it("is null and not warm until the session trades volume", () => {
    const vwap = new SessionVwap();
    expect(vwap.value).toBeNull();
    vwap.update(bar("2026-01-05", 0, { volume: 0 }));
    expect(vwap.value).toBeNull();
    expect(vwap.warmedUp).toBe(false);
    vwap.update(bar("2026-01-05", 1, { volume: 1 }));
    expect(vwap.warmedUp).toBe(true);
  });
});

describe("RelativeVolume", () => {
  const options = { baselineSessions: 2, openingMinutes: 3 };
  const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;

  function feed(rvol: RelativeVolume, session: string, volumes: readonly (number | null)[]): void {
    volumes.forEach((volume, minute) => {
      if (volume !== null) {
        rvol.update(bar(session, minute, { volume }));
      }
    });
  }

  it("is null until the baseline is full, then compares like minutes", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [100, 100, 100, 100]);
    feed(rvol, day(6), [300, 300, 300, 300]);
    expect(rvol.warmedUp).toBe(false);
    expect(rvol.running).toBeNull();
    rvol.update(bar(day(7), 0, { volume: 400 }));
    expect(rvol.warmedUp).toBe(true);
    // 400 against a mean of (100 + 300) / 2 through minute 0.
    expect(rvol.running).toBe(20_000);
    expect(rvol.opening).toBeNull();
  });

  it("freezes opening when the window closes and keeps it for the session", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [100, 100, 100, 100]);
    feed(rvol, day(6), [300, 300, 300, 300]);
    feed(rvol, day(7), [400, 400]);
    expect(rvol.opening).toBeNull();
    rvol.update(bar(day(7), 2, { volume: 400 }));
    // 1,200 through minute 2 against a mean of 600.
    expect(rvol.opening).toBe(20_000);
    rvol.update(bar(day(7), 3, { volume: 50_000 }));
    expect(rvol.opening).toBe(20_000);
    expect(rvol.running).toBe(640_000);
  });

  it("closes the window on the first bar past it when the last window minute has no bar", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [100, 100, 100, 100]);
    feed(rvol, day(6), [300, 300, 300, 300]);
    feed(rvol, day(7), [400, null, null, 9_000]);
    // Only minute 0 traded inside the window: 400 against a mean of 600 through minute 2.
    expect(rvol.opening).toBe(6_666);
  });

  it("reads zero when nothing traded inside the window", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [100, 100, 100, 100]);
    feed(rvol, day(6), [300, 300, 300, 300]);
    feed(rvol, day(7), [null, null, null, null, 700]);
    expect(rvol.opening).toBe(0);
  });

  it("keeps only the most recent baseline sessions", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [1_000_000]);
    feed(rvol, day(6), [100]);
    feed(rvol, day(7), [300]);
    rvol.update(bar(day(8), 0, { volume: 400 }));
    expect(rvol.running).toBe(20_000);
  });

  it("counts a baseline session shorter than the minute asked for at its full total", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [100, 100]);
    feed(rvol, day(6), [300, 300, 300, 300]);
    feed(rvol, day(7), [0, 0, 0, 700]);
    // Through minute 3: the short session's 200 and the full session's 1,200, a mean of 700.
    expect(rvol.running).toBe(10_000);
  });

  it("is null when the baseline traded nothing by that minute", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [0, 100]);
    feed(rvol, day(6), [0, 300]);
    rvol.update(bar(day(7), 0, { volume: 400 }));
    expect(rvol.warmedUp).toBe(true);
    expect(rvol.running).toBeNull();
  });

  it("is null rather than throwing when the ratio leaves the safe integer range", () => {
    const rvol = new RelativeVolume(options);
    feed(rvol, day(5), [1]);
    feed(rvol, day(6), [1]);
    rvol.update(bar(day(7), 0, { volume: 9_000_000_000_000_000 }));
    expect(rvol.running).toBeNull();
  });
});

describe("constructor arguments", () => {
  it("throws on a period or option that is not a whole number of at least 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new Atr(bad)).toThrow(IndicatorError);
      expect(() => new Rsi(bad)).toThrow(IndicatorError);
      expect(() => new RelativeVolume({ baselineSessions: bad, openingMinutes: 5 })).toThrow(IndicatorError);
      expect(() => new RelativeVolume({ baselineSessions: 14, openingMinutes: bad })).toThrow(IndicatorError);
    }
  });
});

describe("isBarAfter", () => {
  it("orders by session first, then by minute", () => {
    expect(isBarAfter(bar("2026-01-06", 0), bar("2026-01-05", 389))).toBe(true);
    expect(isBarAfter(bar("2026-01-05", 389), bar("2026-01-06", 0))).toBe(false);
    expect(isBarAfter(bar("2026-01-05", 5), bar("2026-01-05", 4))).toBe(true);
    expect(isBarAfter(bar("2026-01-05", 4), bar("2026-01-05", 4))).toBe(false);
  });

  it("accepts a well-formed bar, with or without its own vwap", () => {
    expect(isWellFormedBar(bar("2026-01-05", 0))).toBe(true);
    expect(isWellFormedBar(bar("2026-01-05", 0, { vwap: usd(25), volume: 0 }))).toBe(true);
  });
});
