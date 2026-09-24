/**
 * The strategy side of a backtest: ORB driven through the decision core, placing brackets on the
 * simulated broker of a BacktestAdapter.
 *
 * Each session:
 *
 * - Before the open, the universe plans the session and the engine subscribes to its in-play names.
 *   The plan is ranked on the first five minutes, so it is only read once the replay clock has passed
 *   the range close. Until then the engine records bars and nothing else.
 * - From the range close on, every in-play name whose range has provably closed (a bar at or past its
 *   last minute) is asked for a signal exactly once, highest rank first. A signal becomes one trade
 *   plan per variant, each through the cost gate and then either straight to a bracket (per signal) or
 *   through sizing and the risk rules (as deployed).
 * - The stop moves to entry on the bar after a variant's breakeven level is reached.
 * - Entries still working when the cutoff comes are cancelled, so none can fill on the cutoff bar or
 *   later: minute 360 on a full day, 180 on a half day.
 * - Everything still open is flattened at the open of the first bar at or after the flatten minute:
 *   380 on a full day, 200 on a half day. A symbol that prints no bar after it exits at its last close,
 *   at the bell. Both match simulateTrade exactly, and a test holds the two to the same fills.
 *
 * Per signal, a gate rejection still goes in as an order and is recorded as rejected, so the gate's
 * value (Pre-Registration H3) is measured on the same replay. As deployed, a rejection is final, as it
 * would be live.
 *
 * Everything the engine does between bars waits only on the adapter's promises, which the replay drains
 * before the next minute, so its orders are placed in time and in the same order every run. A failure
 * inside that work is kept and thrown on the next clock tick, which stops the replay with the real error.
 */

import type { BacktestAdapter, ReplayEvents, SessionHours } from "@trader/adapters";
import type {
  BracketOrder,
  Direction,
  Fill,
  Fixed,
  Order,
  Quote,
  SetupSignal,
  SymbolBar,
} from "@trader/contracts";
import {
  BREAKER_ARMED,
  type BreakerState,
  type CostModelConfig,
  type CostToRiskConfig,
  type DecisionConfig,
  type EntryDecision,
  type Exposure,
  type MarketState,
  type OrbParams,
  type PortfolioState,
  type Setup,
  SetupError,
  type SymbolState,
  type TradePlan,
  ZERO,
  add,
  buildBracket,
  decideEntry,
  evaluateBreaker,
  evaluateCostToRisk,
  mulRatio,
  planTrade,
  quoteFromReference,
  sub,
} from "@trader/core";
import {
  type RunConfig,
  type VariantConfig,
  costModelFor,
  costToRiskFor,
  decisionFor,
  loadVariant,
} from "./config.js";
import {
  type EntryOutcome,
  type ExitReason,
  type FillRecord,
  type TradeRecord,
  resultOf,
} from "./records.js";
import type { InPlayName, SessionPlan } from "./universe.js";

const MINUTE = 60_000;

/** What the engine knew by the range close. Holds no outcome, so a blind run may keep it. */
export interface SessionStats {
  readonly session: string;
  readonly eligible: number;
  readonly qualified: number;
  readonly inPlay: number;
  readonly unrankable: number;
  /** Which eligible names could not be ranked, and why. A data hole to explain before a result counts. */
  readonly unrankableSymbols: SessionPlan["unrankable"];
  /** Symbols left out as corrupted: the bad-tick filter cut them more than a session can take. */
  readonly corruptSymbols: readonly string[];
  /** In-play names whose opening range gave a signal. */
  readonly signals: number;
  /** Per variant: signals the gate passed, and signals refused before any order. */
  readonly byVariant: Readonly<Record<string, { readonly gatePassed: number; readonly refused: number }>>;
}

export interface SessionOutput {
  readonly stats: SessionStats;
  readonly records: readonly TradeRecord[];
  readonly fills: readonly FillRecord[];
  /** Positions the broker closed at the bell, because the symbol printed nothing after the flatten minute. */
  readonly closedAtSessionEnd: number;
  /** Entries still working at the bell. Always zero: the cutoff cancels them first. */
  readonly expiredEntries: number;
}

export interface EngineOptions {
  readonly config: RunConfig;
  readonly adapter: BacktestAdapter;
  readonly universe: { plan(session: string): Promise<SessionPlan> };
  /** Hears each session once it has closed. The next session waits for it, so it may write to a store. */
  readonly onSession: (output: SessionOutput) => void | Promise<void>;
}

type RecordBase = Omit<
  TradeRecord,
  | "refusal"
  | "shares"
  | "entryOutcome"
  | "entryMinute"
  | "entryReference"
  | "entryFill"
  | "exitMinute"
  | "exitReason"
  | "exitReference"
  | "exitFill"
  | "grossPnl"
  | "netPnl"
  | "grossR"
  | "netR"
>;

/** A bracket the engine placed, followed until it closes. */
interface Tracked {
  readonly base: RecordBase;
  readonly plan: TradePlan;
  readonly clientOrderId: string;
  readonly shares: number;
  readonly breakevenTrigger: Fixed | null;
  /** The live stop-loss order: a replace gives it a new id. */
  stopId: string;
  /** Null while the entry works. */
  entryOutcome: EntryOutcome | null;
  entry: FillRecord | null;
  exit: FillRecord | null;
  exitOrderId: string | null;
  exitLeg: string | null;
  moved: boolean;
}

/** "entry", "stopLoss", "takeProfit", or "flatten": the leg an order id names, replacements included. */
function legOf(orderId: string): string {
  return (orderId.split("/")[1] ?? "").split("~")[0] as string;
}

function describe(decision: Exclude<EntryDecision, { approved: true }>): string {
  switch (decision.stage) {
    case "costToRisk":
      return `costToRisk: ${decision.result.reason}`;
    case "sizing":
      return `sizing: ${decision.result.reason}`;
    case "risk":
      return `risk: ${decision.result.reasons.join(", ")}`;
    case "bracket":
      return `bracket: ${decision.reasons.join(", ")}`;
  }
}

export class BacktestEngine {
  readonly #adapter: BacktestAdapter;
  readonly #universe: EngineOptions["universe"];
  readonly #onSession: EngineOptions["onSession"];
  readonly #variants: readonly VariantConfig[];
  readonly #setups: ReadonlyMap<string, Setup<OrbParams>>;
  /** Every variant sees the same signal: they differ only in stop and exit. */
  readonly #detector: Setup<OrbParams>;
  readonly #costModel: CostModelConfig;
  readonly #costToRisk: CostToRiskConfig;
  /** Null per signal. */
  readonly #decision: DecisionConfig | null;
  readonly #shares: number;
  readonly #openingMinutes: number;
  readonly #cutoffBeforeClose: number;
  readonly #flattenBeforeClose: number;

  #work: Promise<void> = Promise.resolve();
  #persisting: Promise<void> = Promise.resolve();
  #failure: { readonly error: unknown } | null = null;
  #subscribed: readonly string[] = [];

  // The session under way.
  #plan: SessionPlan | null = null;
  #hours: SessionHours | null = null;
  #lastEntryMinute = 0;
  #flattenMinute = 0;
  #minutes = 0;
  readonly #bars = new Map<string, SymbolBar[]>();
  readonly #decided = new Set<string>();
  readonly #tracked = new Map<string, Tracked>();
  readonly #bySymbol = new Map<string, Tracked[]>();
  #refused: TradeRecord[] = [];
  #fills: FillRecord[] = [];
  #signals = 0;
  #byVariant = new Map<string, { gatePassed: number; refused: number }>();
  #startEquity: Fixed | null = null;
  #realized: Fixed = ZERO;
  #breaker: BreakerState = BREAKER_ARMED;

  constructor(options: EngineOptions) {
    const { config, adapter } = options;
    this.#adapter = adapter;
    this.#universe = options.universe;
    this.#onSession = options.onSession;
    this.#variants = config.variants;
    this.#setups = new Map(config.variants.map((variant) => [variant.id, loadVariant(config, variant)]));
    this.#detector = this.#setups.get((config.variants[0] as VariantConfig).id) as Setup<OrbParams>;
    this.#costModel = costModelFor(config);
    this.#costToRisk = costToRiskFor(config);
    this.#decision = decisionFor(config);
    this.#shares = config.account.kind === "perSignal" ? config.account.shares : 0;
    this.#openingMinutes = config.universe.openingRangeMinutes;
    this.#cutoffBeforeClose = config.session.lastEntryMinutesBeforeClose;
    this.#flattenBeforeClose = config.session.flattenMinutesBeforeClose;

    adapter.on("sessionStart", (event) => this.#sessionStart(event));
    adapter.on("minute", (event) => this.#minute(event));
    adapter.on("sessionEnd", (event) => this.#sessionEnd(event));
    adapter.data.on("bar", (bar) => this.#bar(bar));
    adapter.execution.on("orderUpdate", (order) => this.#orderUpdate(order));
    adapter.execution.on("fill", (fill) => this.#fill(fill));
  }

  /**
   * The backtest adapter's universe: plans the session and subscribes to its in-play names before the
   * open. Waits for the previous session's output to be taken first, so a slow store holds the replay
   * back instead of piling up behind it.
   */
  async prepare(hours: SessionHours): Promise<readonly string[]> {
    await this.#persisting;
    this.#throwIfFailed();
    const plan = await this.#universe.plan(hours.session);
    const symbols = plan.inPlay.map((name) => name.symbol);
    const data = this.#adapter.data;
    await data.unsubscribe(this.#subscribed.filter((symbol) => !symbols.includes(symbol)));
    await data.subscribe(symbols);
    this.#subscribed = symbols;
    this.#plan = plan;
    this.#hours = hours;
    return symbols;
  }

  /** Waits for everything the engine started, then throws whatever went wrong in it. */
  async finish(): Promise<void> {
    await this.#work;
    await this.#persisting;
    this.#throwIfFailed();
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) {
      throw this.#failure.error;
    }
  }

  /** Queues work behind everything queued before it. Once anything fails, the rest is skipped. */
  #run(task: () => Promise<unknown>): void {
    this.#work = this.#work
      .then(async () => {
        if (this.#failure === null) {
          await task();
        }
      })
      .catch((error: unknown) => {
        this.#failure ??= { error };
      });
  }

  #sessionStart({ minutes }: ReplayEvents["sessionStart"]): void {
    this.#minutes = minutes;
    this.#lastEntryMinute = minutes - this.#cutoffBeforeClose;
    this.#flattenMinute = minutes - this.#flattenBeforeClose;
    this.#bars.clear();
    this.#decided.clear();
    this.#tracked.clear();
    this.#bySymbol.clear();
    this.#refused = [];
    this.#fills = [];
    this.#signals = 0;
    this.#byVariant = new Map(this.#variants.map((variant) => [variant.id, { gatePassed: 0, refused: 0 }]));
    this.#startEquity = null;
    this.#realized = ZERO;
    this.#breaker = BREAKER_ARMED;
  }

  #minute({ minuteOfSession: m }: ReplayEvents["minute"]): void {
    this.#throwIfFailed();
    // An order placed now first meets minute m + 1, which must still be before the cutoff.
    if (m >= this.#openingMinutes - 1 && m + 1 < this.#lastEntryMinute) {
      this.#run(() => this.#detect(m));
    }
    if (m === this.#lastEntryMinute - 1) {
      this.#run(() => this.#cancelWorking());
    }
    if (m === this.#flattenMinute - 1) {
      this.#run(() => this.#adapter.execution.flattenAll());
    }
  }

  #bar(bar: SymbolBar): void {
    const list = this.#bars.get(bar.symbol);
    if (list === undefined) {
      this.#bars.set(bar.symbol, [bar]);
    } else {
      list.push(bar);
    }
    for (const tracked of this.#bySymbol.get(bar.symbol) ?? []) {
      const trigger = tracked.breakevenTrigger;
      if (tracked.entryOutcome !== "filled" || tracked.exit !== null || trigger === null || tracked.moved) {
        continue;
      }
      const long = tracked.plan.signal.direction === "long";
      if (long ? bar.high >= trigger : bar.low <= trigger) {
        // Protects from the next bar on: the replay drains this before the broker sees another bar.
        tracked.moved = true;
        const stopId = tracked.stopId;
        this.#run(() => this.#adapter.execution.replace(stopId, { stopPrice: tracked.plan.signal.entry }));
      }
    }
  }

  /** Asks each in-play name whose range has closed for its signal, once, highest rank first. */
  async #detect(minute: number): Promise<void> {
    const plan = this.#plan as SessionPlan;
    for (const name of plan.inPlay) {
      if (this.#decided.has(name.symbol)) {
        continue;
      }
      const bars = this.#bars.get(name.symbol);
      const last = bars?.at(-1);
      if (bars === undefined || last === undefined || last.minuteOfSession < this.#openingMinutes - 1) {
        continue;
      }
      this.#decided.add(name.symbol);
      const state: SymbolState = {
        symbol: name.symbol,
        session: plan.session,
        minuteOfSession: last.minuteOfSession,
        lastClose: last.close,
        dailyAtr: name.dailyAtr,
        rsi: null,
        sessionVwap: null,
        openingRvol: name.openingRvol,
        runningRvol: null,
      };
      const market: MarketState = {
        session: plan.session,
        minuteOfSession: minute,
        closeMinute: this.#minutes,
        regime: null,
      };
      if (!this.#detector.evaluateContext(state, market).applies) {
        continue;
      }
      const signal = this.#detector.detectTrigger(state, bars, null);
      if (signal === null) {
        continue;
      }
      this.#signals += 1;
      // The quote a bar-only replay has: the latest close with the modeled spread around it.
      const quote = quoteFromReference(last.close, this.#costModel.spread);
      for (const variant of this.#variants) {
        await this.#enter(variant, name, signal, state, quote);
      }
    }
  }

  async #enter(
    variant: VariantConfig,
    name: InPlayName,
    signal: SetupSignal,
    state: SymbolState,
    quote: Quote,
  ): Promise<void> {
    const counts = this.#byVariant.get(variant.id) as { gatePassed: number; refused: number };
    const signalBase = {
      variant: variant.id,
      symbol: signal.symbol,
      session: signal.session,
      direction: signal.direction,
      rank: name.rank,
      openingRvol: name.openingRvol,
      dailyAtr: name.dailyAtr,
      priorClose: name.priorClose,
      signalMinute: signal.minuteOfSession,
      entry: signal.entry,
    };
    let plan: TradePlan;
    try {
      plan = planTrade(this.#setups.get(variant.id) as Setup<OrbParams>, signal, state);
    } catch (error) {
      // A level that cannot exist, such as a short's 2R target at or below $0, or a wide ATR stop below
      // $0 on a volatile cheap name. The market allowed the signal and no order can express it, so it
      // is recorded as refused, not a reason to stop the run. Anything else the setup throws still does.
      if (!(error instanceof SetupError && error.code === "CONTRACT_VIOLATION")) {
        throw error;
      }
      counts.refused += 1;
      this.#refused.push(
        this.#refusedRecord(
          {
            ...signalBase,
            stop: null,
            target: null,
            costPerShare: null,
            costToRisk: null,
            gatePassed: false,
          },
          0,
          `plan: ${error.message}`,
        ),
      );
      return;
    }
    const long = signal.direction === "long";
    const stopDistance = (long ? sub(signal.entry, plan.stop) : sub(plan.stop, signal.entry)) as Fixed;
    const gate = evaluateCostToRisk({ quote, stopDistance }, this.#costToRisk, this.#costModel);
    if (gate.passed) {
      counts.gatePassed += 1;
    }
    const base: RecordBase = {
      ...signalBase,
      stop: plan.stop,
      target: plan.target,
      costPerShare: gate.costPerShare,
      costToRisk: gate.costToRisk,
      gatePassed: gate.passed,
    };
    const clientOrderId = `${variant.id}-${signal.symbol}-${signal.session.replaceAll("-", "")}`;
    let order: BracketOrder;
    if (this.#decision === null) {
      const built = buildBracket({ plan, shares: this.#shares });
      if (!built.ok) {
        counts.refused += 1;
        this.#refused.push(this.#refusedRecord(base, this.#shares, `bracket: ${built.reasons.join(", ")}`));
        return;
      }
      order = { ...built.order, clientOrderId };
    } else {
      const account = await this.#adapter.execution.getAccount();
      const decision = decideEntry(
        { plan, quote, portfolio: this.#portfolio(account.equity), buyingPower: account.buyingPower },
        this.#decision,
      );
      if (!decision.approved) {
        counts.refused += 1;
        this.#refused.push(this.#refusedRecord(base, 0, describe(decision)));
        return;
      }
      order = { ...decision.order, clientOrderId };
    }
    const management = plan.management.breakevenAtR;
    const risk = long ? sub(signal.entry, plan.stop) : sub(plan.stop, signal.entry);
    const reach = management === null ? null : mulRatio(risk, management, "ceil");
    const tracked: Tracked = {
      base,
      plan,
      clientOrderId,
      shares: order.quantity,
      breakevenTrigger: reach === null ? null : long ? add(signal.entry, reach) : sub(signal.entry, reach),
      stopId: `${clientOrderId}/stopLoss`,
      entryOutcome: null,
      entry: null,
      exit: null,
      exitOrderId: null,
      exitLeg: null,
      moved: false,
    };
    this.#tracked.set(clientOrderId, tracked);
    const list = this.#bySymbol.get(signal.symbol);
    if (list === undefined) {
      this.#bySymbol.set(signal.symbol, [tracked]);
    } else {
      list.push(tracked);
    }
    await this.#adapter.execution.submitBracket(order);
  }

  /**
   * The account as the risk rules see it: marked equity, the session's realized P&L, and every working
   * entry and open position with the stop it has now. Advances the daily-loss breaker as it goes.
   */
  #portfolio(equity: Fixed): PortfolioState {
    const config = this.#decision as DecisionConfig;
    this.#startEquity ??= equity;
    const account = { equity, startOfDayEquity: this.#startEquity, realizedPnlToday: this.#realized };
    this.#breaker = evaluateBreaker(this.#breaker, account, config.risk).state;
    const exposures: Exposure[] = [];
    for (const tracked of this.#tracked.values()) {
      const working = tracked.entryOutcome === null;
      const open = tracked.entryOutcome === "filled" && tracked.exit === null;
      if (!working && !open) {
        continue;
      }
      const { signal, stop } = tracked.plan;
      exposures.push({
        symbol: signal.symbol,
        direction: signal.direction,
        shares: tracked.shares,
        entry: tracked.entry?.price ?? signal.entry,
        stop: tracked.moved ? signal.entry : stop,
      });
    }
    return { account, exposures, breaker: this.#breaker };
  }

  async #cancelWorking(): Promise<void> {
    for (const tracked of this.#tracked.values()) {
      if (tracked.entryOutcome === null) {
        await this.#adapter.execution.cancel(`${tracked.clientOrderId}/entry`);
      }
    }
  }

  #orderUpdate(order: Order): void {
    const tracked = this.#tracked.get(order.clientOrderId);
    if (tracked === undefined) {
      return;
    }
    if (order.leg === "entry" && (order.status === "canceled" || order.status === "expired")) {
      tracked.entryOutcome = order.status;
    } else if (order.leg === "stopLoss" && order.status === "accepted") {
      tracked.stopId = order.id;
    }
  }

  #fill(fill: Fill): void {
    const hours = this.#hours as SessionHours;
    const basis = this.#adapter.execution.fillBasis(fill.id);
    if (basis === undefined) {
      throw new Error(`the broker has no basis for ${fill.id}`);
    }
    const record: FillRecord = {
      fillId: fill.id,
      orderId: fill.orderId,
      clientOrderId: fill.clientOrderId,
      leg: legOf(fill.orderId),
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      reference: basis.reference,
      kind: basis.kind,
      fees: fill.fees,
      at: fill.at,
      minute: Math.round((Date.parse(fill.at) - hours.openAt) / MINUTE),
    };
    this.#fills.push(record);
    const tracked = this.#tracked.get(fill.clientOrderId);
    if (tracked === undefined) {
      return;
    }
    if (record.leg === "entry") {
      tracked.entry = record;
      tracked.entryOutcome = "filled";
      return;
    }
    tracked.exit = record;
    tracked.exitOrderId = fill.orderId;
    tracked.exitLeg = record.leg;
    if (tracked.entry !== null) {
      const { signal, stop } = tracked.plan;
      this.#realized = add(
        this.#realized,
        resultOf(signal.direction, signal.entry, stop, tracked.entry, record).netPnl,
      );
    }
  }

  #sessionEnd({ hours, closed, expired }: ReplayEvents["sessionEnd"]): void {
    this.#throwIfFailed();
    const plan = this.#plan as SessionPlan;
    const closedIds = new Set(closed.map((order) => order.id));
    const records = [
      ...this.#refused,
      ...[...this.#tracked.values()].map((t) => this.#finalRecord(t, closedIds)),
    ];
    const output: SessionOutput = {
      stats: {
        session: hours.session,
        eligible: plan.eligible,
        qualified: plan.qualified,
        inPlay: plan.inPlay.length,
        unrankable: plan.unrankable.length,
        unrankableSymbols: plan.unrankable,
        corruptSymbols: plan.corrupt,
        signals: this.#signals,
        byVariant: Object.fromEntries(this.#byVariant),
      },
      records,
      fills: this.#fills,
      closedAtSessionEnd: closed.length,
      expiredEntries: expired.length,
    };
    this.#plan = null;
    this.#persisting = this.#persisting
      .then(() => this.#onSession(output))
      .catch((error: unknown) => {
        this.#failure ??= { error };
      });
  }

  #refusedRecord(base: RecordBase, shares: number, refusal: string): TradeRecord {
    return {
      ...base,
      refusal,
      shares,
      entryOutcome: "refused",
      entryMinute: null,
      entryReference: null,
      entryFill: null,
      exitMinute: null,
      exitReason: null,
      exitReference: null,
      exitFill: null,
      grossPnl: null,
      netPnl: null,
      grossR: null,
      netR: null,
    };
  }

  #finalRecord(tracked: Tracked, closedAtBell: ReadonlySet<string>): TradeRecord {
    const { base, shares, entry, exit } = tracked;
    const unfilled = {
      ...this.#refusedRecord(base, shares, ""),
      refusal: null,
    };
    if (tracked.entryOutcome === "canceled" || tracked.entryOutcome === "expired") {
      return { ...unfilled, entryOutcome: tracked.entryOutcome };
    }
    if (tracked.entryOutcome !== "filled" || entry === null || exit === null) {
      throw new Error(
        `${tracked.clientOrderId} reached the close still open; the broker should have closed it`,
      );
    }
    const reasons: Record<string, ExitReason> = {
      stopLoss: tracked.moved ? "breakevenStop" : "stop",
      takeProfit: "target",
      flatten: closedAtBell.has(tracked.exitOrderId as string) ? "close" : "flatten",
    };
    const { signal, stop } = tracked.plan;
    return {
      ...unfilled,
      entryOutcome: "filled",
      entryMinute: entry.minute,
      entryReference: entry.reference,
      entryFill: entry.price,
      exitMinute: exit.minute,
      exitReason: reasons[tracked.exitLeg as string] as ExitReason,
      exitReference: exit.reference,
      exitFill: exit.price,
      ...resultOf(signal.direction as Direction, signal.entry, stop, entry, exit),
    };
  }
}
