import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Bar } from "./bars.js";
import { fromNumber, ratio, type Fixed } from "./money.js";
import { noopSetupDefinition } from "./noopSetup.js";
import {
  SetupError,
  loadSetup,
  type MarketState,
  type SetupBehavior,
  type SetupDefinition,
  type SetupSignal,
  type SymbolState,
} from "./setup.js";

const usd = fromNumber;

const symbol: SymbolState = {
  symbol: "AAA",
  session: "2026-01-05",
  minuteOfSession: 5,
  lastClose: usd(20),
  dailyAtr: usd(1.5),
  rsi: 55,
  sessionVwap: usd(19.95),
  openingRvol: ratio(25_000),
  runningRvol: ratio(18_000),
};
const market: MarketState = { session: "2026-01-05", minuteOfSession: 5, closeMinute: 390, regime: null };

const bar = (minuteOfSession: number, closed = true): Bar => ({
  session: "2026-01-05",
  minuteOfSession,
  open: usd(20),
  high: usd(20.1),
  low: usd(19.9),
  close: usd(20.05),
  volume: 1_000,
  vwap: null,
  closed,
});

// A small setup with bounded parameters, the shape a real one takes.
const gateParams = z.object({
  minOpeningRvol: z.number().int().min(10_000).max(100_000).default(10_000),
  stopAtrBps: z.number().int().min(100).max(10_000),
});

function signalFor(
  definition: { id: string; version: string },
  overrides: Partial<SetupSignal> = {},
): SetupSignal {
  return {
    setupId: definition.id,
    setupVersion: definition.version,
    symbol: "AAA",
    direction: "long",
    session: "2026-01-05",
    minuteOfSession: 4,
    entryType: "stop",
    entry: usd(20.1),
    ...overrides,
  };
}

/** Builds a definition whose answers are scripted, to drive the loader's contract checks. */
function scripted(
  behavior: Partial<SetupBehavior>,
  meta: Partial<SetupDefinition<typeof gateParams>> = {},
): SetupDefinition<typeof gateParams> {
  return {
    id: "gate",
    version: "0.1.0",
    directions: ["long"],
    warmup: { dailyBars: 14, sessions: 14, sessionBars: 5 },
    paramsSchema: gateParams,
    create: (params) => ({
      evaluateContext: (state) => {
        if (state.openingRvol === null) {
          return { applies: false, reasons: ["RVOL_NOT_WARM"] };
        }
        return state.openingRvol >= params.minOpeningRvol
          ? { applies: true }
          : { applies: false, reasons: ["RVOL_BELOW_MIN"] };
      },
      detectTrigger: () => null,
      stop: () => usd(20),
      target: () => null,
      invalidation: () => false,
      ...behavior,
    }),
    ...meta,
  };
}

function expectCode(run: () => unknown, code: string, ...fragments: string[]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).code).toBe(code);
    for (const fragment of fragments) {
      expect((error as SetupError).message).toContain(fragment);
    }
    return;
  }
  throw new Error(`expected SetupError ${code}`);
}

describe("loadSetup with the no-op setup", () => {
  const setup = loadSetup(noopSetupDefinition, {});

  it("carries the definition's metadata and the parsed parameters", () => {
    expect(setup.id).toBe("noop");
    expect(setup.version).toBe("1.0.0");
    expect(setup.directions).toEqual(["long", "short"]);
    expect(setup.warmup).toEqual({ dailyBars: 0, sessions: 0, sessionBars: 0 });
    expect(setup.params).toEqual({});
  });

  it("never applies and never signals", () => {
    expect(setup.evaluateContext(symbol, market)).toEqual({
      applies: false,
      reasons: ["NOOP_NEVER_APPLIES"],
    });
    expect(setup.detectTrigger(symbol, [bar(0), bar(1)], null)).toBeNull();
  });

  it("still answers within the contract for a hand-built signal, long and short", () => {
    const long = signalFor(noopSetupDefinition);
    const short = signalFor(noopSetupDefinition, { direction: "short" });
    expect(setup.stop(long, symbol)).toBe(usd(20.09));
    expect(setup.stop(short, symbol)).toBe(usd(20.11));
    expect(setup.target(long, symbol)).toBeNull();
    expect(setup.invalidation(long, symbol)).toBe(true);
  });
});

describe("loadSetup parameter validation", () => {
  it("applies defaults and keeps parsed values", () => {
    expect(loadSetup(scripted({}), { stopAtrBps: 1_000 }).params).toEqual({
      minOpeningRvol: 10_000,
      stopAtrBps: 1_000,
    });
  });

  it("fails at load on a wrong type, naming the parameter", () => {
    expectCode(
      () => loadSetup(scripted({}), { stopAtrBps: "1000" }),
      "INVALID_PARAMS",
      '"gate"',
      "stopAtrBps",
    );
  });

  it("fails at load on a missing or out-of-bounds value", () => {
    expectCode(() => loadSetup(scripted({}), {}), "INVALID_PARAMS", "stopAtrBps");
    expectCode(() => loadSetup(scripted({}), { stopAtrBps: 99 }), "INVALID_PARAMS", "stopAtrBps");
    expectCode(
      () => loadSetup(scripted({}), { stopAtrBps: 1_000, minOpeningRvol: 100_001 }),
      "INVALID_PARAMS",
    );
    expectCode(() => loadSetup(scripted({}), { stopAtrBps: 1_000.5 }), "INVALID_PARAMS");
  });

  it("fails at load on a misspelled key instead of silently using the default", () => {
    expectCode(
      () => loadSetup(scripted({}), { stopAtrBps: 1_000, minOpeningRvoI: 30_000 }),
      "INVALID_PARAMS",
      "(root)",
      "minOpeningRvoI",
    );
  });

  it("fails at load when the parameters are not an object", () => {
    expectCode(() => loadSetup(scripted({}), "stopAtrBps=1000"), "INVALID_PARAMS", "(root)");
    expectCode(() => loadSetup(scripted({}), null), "INVALID_PARAMS");
  });

  it("reports every failing parameter at once", () => {
    expectCode(
      () => loadSetup(scripted({}), { stopAtrBps: 0, minOpeningRvol: 1 }),
      "INVALID_PARAMS",
      "stopAtrBps",
      "minOpeningRvol",
    );
  });
});

describe("loadSetup definition validation", () => {
  const params = { stopAtrBps: 1_000 };

  it("rejects bad metadata and lists every problem", () => {
    expectCode(() => loadSetup(scripted({}, { id: "" }), params), "INVALID_DEFINITION", "id is empty");
    expectCode(
      () => loadSetup(scripted({}, { version: "" }), params),
      "INVALID_DEFINITION",
      "version is empty",
    );
    expectCode(() => loadSetup(scripted({}, { directions: [] }), params), "INVALID_DEFINITION", "directions");
    expectCode(
      () => loadSetup(scripted({}, { directions: ["long", "long"] }), params),
      "INVALID_DEFINITION",
      "directions",
    );
    expectCode(
      () =>
        loadSetup(
          scripted({}, { version: "", warmup: { dailyBars: -1, sessions: 1.5, sessionBars: 5 } }),
          params,
        ),
      "INVALID_DEFINITION",
      "version is empty",
      "warmup.dailyBars",
      "warmup.sessions",
    );
  });
});

describe("the loaded setup's contract checks", () => {
  const params = { stopAtrBps: 1_000 };
  const definition = scripted({});
  const long = signalFor(definition);
  const short = signalFor(definition, { direction: "short" });

  it("passes evaluateContext and invalidation straight through", () => {
    const setup = loadSetup(scripted({ invalidation: (_, state) => state.minuteOfSession > 60 }), params);
    expect(setup.evaluateContext(symbol, market)).toEqual({ applies: true });
    expect(setup.evaluateContext({ ...symbol, openingRvol: ratio(9_999) }, market)).toEqual({
      applies: false,
      reasons: ["RVOL_BELOW_MIN"],
    });
    expect(setup.evaluateContext({ ...symbol, openingRvol: null }, market)).toEqual({
      applies: false,
      reasons: ["RVOL_NOT_WARM"],
    });
    expect(setup.invalidation(long, symbol)).toBe(false);
    expect(setup.invalidation(long, { ...symbol, minuteOfSession: 61 })).toBe(true);
  });

  it("never lets a setup see a bar that is still forming", () => {
    const seen: Bar[][] = [];
    const setup = loadSetup(
      scripted({
        detectTrigger: (_, bars) => {
          seen.push([...bars]);
          return null;
        },
      }),
      params,
    );
    expect(setup.detectTrigger(symbol, [bar(0), bar(1), bar(2, false)], null)).toBeNull();
    expect(seen).toEqual([[bar(0), bar(1)]]);
  });

  it("returns a signal that honors the contract", () => {
    const setup = loadSetup(scripted({ detectTrigger: () => long }), params);
    expect(setup.detectTrigger(symbol, [bar(4)], { bid: usd(20.08), ask: usd(20.1) })).toEqual(long);
  });

  it("throws on a signal outside the declared directions, from another setup, or with a bad entry", () => {
    const emits = (signal: SetupSignal) => loadSetup(scripted({ detectTrigger: () => signal }), params);
    expectCode(() => emits(short).detectTrigger(symbol, [], null), "CONTRACT_VIOLATION", "direction");
    expectCode(
      () => emits({ ...long, setupId: "orb" }).detectTrigger(symbol, [], null),
      "CONTRACT_VIOLATION",
    );
    expectCode(
      () => emits({ ...long, setupVersion: "9" }).detectTrigger(symbol, [], null),
      "CONTRACT_VIOLATION",
    );
    expectCode(() => emits({ ...long, entry: usd(0) }).detectTrigger(symbol, [], null), "CONTRACT_VIOLATION");
    expectCode(
      () => emits({ ...long, entry: Number.NaN as Fixed }).detectTrigger(symbol, [], null),
      "CONTRACT_VIOLATION",
    );
  });

  it("throws on a stop that is not on the risk side of entry", () => {
    const both = { directions: ["long", "short"] } as const;
    const stopsAt = (price: Fixed) => loadSetup(scripted({ stop: () => price }, both), params);
    expect(stopsAt(usd(19.9)).stop(long, symbol)).toBe(usd(19.9));
    expect(stopsAt(usd(20.3)).stop(short, symbol)).toBe(usd(20.3));
    expectCode(() => stopsAt(usd(20.1)).stop(long, symbol), "CONTRACT_VIOLATION", "stop");
    expectCode(() => stopsAt(usd(20.3)).stop(long, symbol), "CONTRACT_VIOLATION");
    expectCode(() => stopsAt(usd(19.9)).stop(short, symbol), "CONTRACT_VIOLATION");
    expectCode(() => stopsAt(usd(0)).stop(long, symbol), "CONTRACT_VIOLATION");
    expectCode(() => stopsAt(Number.NaN as Fixed).stop(long, symbol), "CONTRACT_VIOLATION");
  });

  it("allows a null target and throws on one that is not on the profit side of entry", () => {
    const both = { directions: ["long", "short"] } as const;
    const targets = (price: Fixed | null) => loadSetup(scripted({ target: () => price }, both), params);
    expect(targets(null).target(long, symbol)).toBeNull();
    expect(targets(usd(20.7)).target(long, symbol)).toBe(usd(20.7));
    expect(targets(usd(19.5)).target(short, symbol)).toBe(usd(19.5));
    expectCode(() => targets(usd(20.1)).target(long, symbol), "CONTRACT_VIOLATION", "target");
    expectCode(() => targets(usd(19.5)).target(long, symbol), "CONTRACT_VIOLATION");
    expectCode(() => targets(usd(20.7)).target(short, symbol), "CONTRACT_VIOLATION");
    expectCode(() => targets(usd(0)).target(short, symbol), "CONTRACT_VIOLATION");
    expectCode(() => targets(Number.NaN as Fixed).target(long, symbol), "CONTRACT_VIOLATION");
  });
});
