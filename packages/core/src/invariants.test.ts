/**
 * The invariant suite: thousands of seeded synthetic sessions through the decision core, each one
 * checked against the rules no path may break.
 *
 * Every session is a scripted portfolio walk. Several symbols signal in turn, the core decides each
 * entry with the portfolio as it stands, the simulator plays the approved ones forward, and the
 * breaker advances on the equity that results. The invariants are then checked on every decision and
 * every trade. A failure prints the seed and the scenario so the path can be replayed alone.
 *
 * Restated independently of the code under test: each limit here is a multiplication against the
 * config, sharing no division or rounding with sizing or the risk rules.
 *
 * The path count comes from INVARIANT_PATHS: 2,000 on every push and far more nightly.
 *
 * Reconciliation after a crash, partial fills, and bad ticks reaching the engine wait on the adapter,
 * the order lifecycle manager, and the bad-tick filter. Their invariants are listed in the epic and
 * are not here yet.
 */

import { describe, expect, it } from "vitest";
import type { Bar } from "./bars.js";
import { DEFAULT_COST_TO_RISK } from "./costToRisk.js";
import { DEFAULT_COST_MODEL } from "./costs.js";
import { type DecisionConfig, type EntryDecision, decideEntry } from "./decision.js";
import { type Fixed, fixed, ratio } from "./money.js";
import { orbSetupDefinition } from "./orb.js";
import { DEFAULT_PATH_CONFIG, SCRIPTED_SCENARIOS, createRng, generatePath, type Scenario } from "./paths.js";
import {
  BREAKER_ARMED,
  DEFAULT_RISK_CONFIG,
  type AccountState,
  type BreakerState,
  type Exposure,
  evaluateBreaker,
  evaluateOrder,
} from "./riskRules.js";
import { loadSetup, planTrade, type SymbolState, type TradePlan } from "./setup.js";
import { simulateTrade, type FilledTrade } from "./tradeSim.js";

/** 2,000 on every run, which takes well under a second. The nightly workflow sets a much larger count. */
export const INVARIANT_PATHS = Number(process.env["INVARIANT_PATHS"] ?? 2_000);

const SCALE = 10_000n;
const SYMBOLS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"] as const;
const SCENARIOS: readonly Scenario[] = ["driftlessWalk", ...SCRIPTED_SCENARIOS];

const CONFIG: DecisionConfig = {
  costModel: DEFAULT_COST_MODEL,
  costToRisk: DEFAULT_COST_TO_RISK,
  // Deliberately loose: 2.5% risk per trade, 5% open risk, and a 4% daily limit, so a couple of
  // stop-outs in the first wave trip the breaker before the second wave decides, on some seeds.
  sizing: { riskPerTrade: ratio(250), maxPositionPct: ratio(2_500), regime: { kind: "proven" } },
  risk: {
    ...DEFAULT_RISK_CONFIG,
    maxConcurrentPositions: 3,
    maxOpenRisk: ratio(500),
    dailyLossLimit: ratio(400),
  },
};
const FLATTEN_MINUTE = 380;

interface Decided {
  readonly symbol: string;
  readonly plan: TradePlan;
  readonly decision: EntryDecision;
  /** The portfolio the decision was made against. */
  readonly exposuresBefore: readonly Exposure[];
  readonly accountBefore: AccountState;
  readonly breakerBefore: BreakerState;
  readonly trade: FilledTrade | null;
}

interface Walk {
  readonly seed: number;
  readonly decisions: readonly Decided[];
  readonly finalExposures: readonly Exposure[];
  readonly breakerLog: readonly {
    readonly account: AccountState;
    readonly before: BreakerState;
    readonly after: BreakerState;
  }[];
}

interface Candidate {
  readonly symbol: string;
  readonly plan: TradePlan;
  readonly quote: { readonly bid: Fixed; readonly ask: Fixed };
  readonly bars: readonly Bar[];
}

/** A symbol with its own seeded path, signalled by the range-low ORB. Null when the range gives no signal. */
function candidate(seed: number, index: number, rng: ReturnType<typeof createRng>): Candidate | null {
  // The published 10% ATR stop, with the ATR chosen so the stop lands exactly where the script aimed.
  const setup = loadSetup(orbSetupDefinition, {});
  const symbol = SYMBOLS[index] as string;
  const scenario = SCENARIOS[rng.int(0, SCENARIOS.length - 1)] as Scenario;
  const startPrice = rng.int(5, 95) * 10_000;
  // Stops from 1% to 8% of price. Wide enough that the cost gate passes most names and refuses some.
  const stopDistance = Math.max(1_000, Math.round((startPrice * rng.int(100, 800)) / 10_000 / 100) * 100);
  const generated = generatePath({
    ...DEFAULT_PATH_CONFIG,
    scenario,
    seed: seed * 101 + index,
    startPrice: fixed(startPrice),
    volatilityBps: rng.int(5, 40),
    stopDistance: fixed(stopDistance),
  });
  const range = generated.bars.filter((bar) => bar.minuteOfSession < 5);
  const last = range.at(-1) as Bar;
  const symbolState: SymbolState = {
    symbol,
    session: generated.session,
    minuteOfSession: last.minuteOfSession,
    lastClose: last.close,
    dailyAtr: fixed(stopDistance * 10),
    rsi: null,
    sessionVwap: null,
    openingRvol: ratio(rng.int(5_000, 40_000)),
    runningRvol: null,
  };
  const signal = setup.detectTrigger(symbolState, range, null);
  if (signal === null) {
    return null;
  }
  return {
    symbol,
    plan: planTrade(setup, signal, symbolState),
    quote: generated.quotes[4] as { bid: Fixed; ask: Fixed },
    bars: generated.bars,
  };
}

/**
 * One portfolio session in two waves. Wave one decides several symbols at the range close, so their
 * exposures pile up and the concurrency, open-risk, and cap rules bind. Their trades then run and exit
 * in minute order, each exit moving equity and advancing the breaker. Wave two decides more symbols
 * at minute 200 against what is still open, what was realized, and the breaker as it stands, so the
 * daily budget and a tripped breaker gate real decisions. Every position is closed by the flatten.
 */
function walk(seed: number): Walk {
  const rng = createRng(seed);
  const startOfDayEquity = fixed(rng.int(20_000_000, 60_000_000));
  let equity = startOfDayEquity;
  let realized: Fixed = fixed(0);
  let breaker = BREAKER_ARMED;
  let open: { exposure: Exposure; trade: FilledTrade }[] = [];
  const decisions: Decided[] = [];
  const breakerLog: { account: AccountState; before: BreakerState; after: BreakerState }[] = [];

  const settleExitsThrough = (minute: number): void => {
    const exiting = open
      .filter(({ trade }) => trade.exitMinute <= minute)
      .sort((a, b) => a.trade.exitMinute - b.trade.exitMinute);
    open = open.filter(({ trade }) => trade.exitMinute > minute);
    for (const { trade } of exiting) {
      equity = fixed(equity + trade.netPnl);
      realized = fixed(realized + trade.netPnl);
      const account: AccountState = { equity, startOfDayEquity, realizedPnlToday: realized };
      const advanced = evaluateBreaker(breaker, account, CONFIG.risk);
      breakerLog.push({ account, before: breaker, after: advanced.state });
      breaker = advanced.state;
    }
  };

  const decide = (c: Candidate, fromMinute: number): void => {
    const exposures = open.map(({ exposure }) => exposure);
    const account: AccountState = { equity, startOfDayEquity, realizedPnlToday: realized };
    const before = { exposuresBefore: exposures, accountBefore: account, breakerBefore: breaker };
    const openNotional = exposures.reduce((sum, e) => sum + e.entry * e.shares, 0);
    const decision = decideEntry(
      {
        plan: c.plan,
        quote: c.quote,
        portfolio: { account, exposures, breaker },
        buyingPower: fixed(Math.max(equity - openNotional, 0)),
      },
      CONFIG,
    );
    let trade: FilledTrade | null = null;
    if (decision.approved) {
      const outcome = simulateTrade(
        c.plan,
        c.bars.filter((bar) => bar.minuteOfSession >= fromMinute),
        {
          shares: decision.order.quantity,
          costModel: DEFAULT_COST_MODEL,
          lastEntryMinute: 360,
          flattenMinute: FLATTEN_MINUTE,
        },
      );
      if (outcome.filled) {
        trade = outcome;
        const { signal } = c.plan;
        open.push({
          exposure: {
            symbol: c.symbol,
            direction: signal.direction,
            shares: outcome.shares,
            entry: signal.entry,
            stop: c.plan.stop,
          },
          trade: outcome,
        });
      }
    }
    decisions.push({ symbol: c.symbol, plan: c.plan, decision, ...before, trade });
  };

  const firstWave = rng.int(2, 5);
  const candidates = SYMBOLS.map((_, i) => candidate(seed, i, rng)).filter((c): c is Candidate => c !== null);
  candidates.slice(0, firstWave).forEach((c) => decide(c, 5));
  settleExitsThrough(200);
  candidates.slice(firstWave).forEach((c) => decide(c, 200));
  settleExitsThrough(FLATTEN_MINUTE);

  return { seed, decisions, finalExposures: open.map(({ exposure }) => exposure), breakerLog };
}

const big = (value: number): bigint => BigInt(value);
const riskOf = (e: Exposure): bigint =>
  e.stop === null
    ? 0n
    : big(Math.max(e.direction === "long" ? e.entry - e.stop : e.stop - e.entry, 0)) * big(e.shares);

describe(`invariants over ${INVARIANT_PATHS} seeded sessions`, () => {
  const walks = Array.from({ length: INVARIANT_PATHS }, (_, i) => walk(i + 1));
  const approvals = walks.flatMap((w) =>
    w.decisions.filter((d) => d.decision.approved).map((d) => ({ w, d })),
  );

  it("exercises approvals, refusals at every stage, fills, stop-outs, and a tripped breaker", () => {
    const stages = new Set(
      walks.flatMap((w) => w.decisions.map((d) => (d.decision.approved ? "approved" : d.decision.stage))),
    );
    expect(stages).toContain("approved");
    expect(stages).toContain("costToRisk");
    expect(stages).toContain("risk");
    const reasons = new Set(approvals.map(({ d }) => d.trade?.exitReason ?? "unfilled"));
    expect(reasons).toContain("stop");
    expect(reasons).toContain("eod");
    expect(walks.some((w) => w.breakerLog.some((entry) => entry.after.tripped))).toBe(true);
    // Decisions made after the breaker tripped, so the "no entry after it" invariant is not vacuous.
    const gated = walks.flatMap((w) => w.decisions.filter((d) => d.breakerBefore.tripped));
    expect(gated.length).toBeGreaterThan(10);
    expect(gated.some((d) => !d.decision.approved && d.decision.stage === "risk")).toBe(true);
  });

  it("never risks more than the configured cap on any single approved trade", () => {
    for (const { w, d } of approvals) {
      const { plan, accountBefore, decision } = d;
      if (!decision.approved) {
        continue;
      }
      const risk = big(plan.signal.entry - plan.stop) * big(decision.order.quantity);
      const where = `seed ${w.seed} ${d.symbol}`;
      expect(risk * SCALE, where).toBeLessThanOrEqual(
        big(accountBefore.equity) * big(CONFIG.sizing.riskPerTrade),
      );
      const notional = big(plan.signal.entry) * big(decision.order.quantity);
      expect(notional * SCALE, where).toBeLessThanOrEqual(
        big(accountBefore.equity) * big(CONFIG.sizing.maxPositionPct),
      );
      expect(notional, where).toBeLessThanOrEqual(big(accountBefore.equity));
    }
  });

  it("never exceeds the max concurrent positions or the aggregate open-risk ceiling", () => {
    for (const { w, d } of approvals) {
      if (!d.decision.approved) {
        continue;
      }
      const after: readonly Exposure[] = [
        ...d.exposuresBefore,
        {
          symbol: d.symbol,
          direction: "long",
          shares: d.decision.order.quantity,
          entry: d.plan.signal.entry,
          stop: d.plan.stop,
        },
      ];
      const where = `seed ${w.seed} ${d.symbol}`;
      expect(new Set(after.map((e) => e.symbol)).size, where).toBeLessThanOrEqual(
        CONFIG.risk.maxConcurrentPositions,
      );
      const openRisk = after.reduce((sum, e) => sum + riskOf(e), 0n);
      expect(openRisk * SCALE, where).toBeLessThanOrEqual(
        big(d.accountBefore.equity) * big(CONFIG.risk.maxOpenRisk),
      );
    }
  });

  it("gives every approved entry a broker-side stop on the risk side, in the same order", () => {
    for (const { w, d } of approvals) {
      if (!d.decision.approved) {
        continue;
      }
      const { order } = d.decision;
      const where = `seed ${w.seed} ${d.symbol}`;
      expect(order.stopLoss.stopPrice, where).toBe(d.plan.stop);
      expect(order.stopLoss.stopPrice, where).toBeLessThan(d.plan.signal.entry);
      expect(order.orderClass, where).toBe("oto");
    }
  });

  it("trips the breaker exactly at the threshold, latches it, and approves no entry after it", () => {
    for (const w of walks) {
      for (const { account, before, after } of w.breakerLog) {
        const loss = big(account.startOfDayEquity - account.equity) * SCALE;
        const limit = big(account.startOfDayEquity) * big(CONFIG.risk.dailyLossLimit);
        const shouldTrip = before.tripped || loss >= limit;
        expect(after.tripped, `seed ${w.seed}`).toBe(shouldTrip);
      }
      for (const d of w.decisions) {
        if (d.breakerBefore.tripped) {
          expect(d.decision.approved, `seed ${w.seed} ${d.symbol}`).toBe(false);
        }
      }
    }
  });

  it("refuses an entry whenever the live equity is already at the loss limit, latched or not", () => {
    for (const w of walks) {
      for (const d of w.decisions) {
        const loss = big(d.accountBefore.startOfDayEquity - d.accountBefore.equity) * SCALE;
        const limit = big(d.accountBefore.startOfDayEquity) * big(CONFIG.risk.dailyLossLimit);
        if (loss >= limit) {
          expect(d.decision.approved, `seed ${w.seed} ${d.symbol}`).toBe(false);
        }
      }
    }
  });

  it("lets no position survive the EOD flatten", () => {
    for (const w of walks) {
      expect(w.finalExposures, `seed ${w.seed}`).toEqual([]);
      for (const { d } of approvals.filter((a) => a.w === w)) {
        if (d.trade !== null) {
          expect(d.trade.exitMinute, `seed ${w.seed} ${d.symbol}`).toBeLessThanOrEqual(FLATTEN_MINUTE);
        }
      }
    }
  });

  it("charges every fill, so no trade nets more than its gross", () => {
    for (const { w, d } of approvals) {
      if (d.trade !== null) {
        expect(d.trade.netPnl, `seed ${w.seed} ${d.symbol}`).toBeLessThan(d.trade.grossPnl);
      }
    }
  });

  it("decides the same way twice for the same seed", () => {
    for (const seed of [1, 2, 3, 250, 251]) {
      expect(walk(seed)).toEqual(walk(seed));
    }
  });
});

describe("the suite catches a broken invariant", () => {
  it("fails when the concurrency check is removed", () => {
    // The same decision with the concurrency rule loosened to 20 approves an entry the suite must flag.
    const loosened: DecisionConfig = { ...CONFIG, risk: { ...CONFIG.risk, maxConcurrentPositions: 20 } };
    const crowded: Exposure[] = ["AAA", "BBB", "CCC"].map((symbol) => ({
      symbol,
      direction: "long",
      shares: 1,
      entry: fixed(200_000),
      stop: fixed(190_000),
    }));
    const plan: TradePlan = {
      signal: {
        setupId: "orb",
        setupVersion: "1.0.0",
        symbol: "DDD",
        direction: "long",
        session: "2026-01-05",
        minuteOfSession: 4,
        entryType: "stop",
        entry: fixed(203_000),
        levels: {},
      },
      stop: fixed(199_500),
      target: null,
      management: { breakevenAtR: null },
    };
    const portfolio = {
      account: { equity: fixed(25_000_000), startOfDayEquity: fixed(25_000_000), realizedPnlToday: fixed(0) },
      exposures: crowded,
      breaker: BREAKER_ARMED,
    };
    const input = {
      plan,
      quote: { bid: fixed(202_100), ask: fixed(202_200) },
      portfolio,
      buyingPower: fixed(25_000_000),
    };
    const strict = decideEntry(input, CONFIG);
    const broken = decideEntry(input, loosened);
    expect(strict).toMatchObject({ approved: false, stage: "risk" });
    expect(broken.approved).toBe(true);
    // The invariant, restated: a fourth symbol is over the configured limit of three.
    const symbolsAfter = new Set([...crowded.map((e) => e.symbol), "DDD"]).size;
    expect(symbolsAfter > CONFIG.risk.maxConcurrentPositions).toBe(true);
    expect(
      evaluateOrder({ intent: "entry", ...plan.signal, stop: plan.stop, shares: 1 }, portfolio, CONFIG.risk)
        .allowed,
    ).toBe(false);
  });
});

/** Replays one seed by hand: the walk a failure message names. */
export { walk as replayInvariantWalk };
