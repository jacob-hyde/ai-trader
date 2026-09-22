/**
 * Turns a trade plan into an order, or refuses it with the stage and reason.
 *
 * Is the whole decision core in one call, in the order the engine runs it: the cost-to-risk gate, then
 * sizing, then the risk rules, then the bracket builder. Every stage is pure, so this is pure too. Same
 * inputs, same decision, in backtest, paper, and live.
 *
 * The stages run in that order on purpose. The gate is the cheapest and rejects most candidates. Sizing
 * needs the gate's cost per share. The rules need the sized share count. The bracket needs everything.
 * A refusal names the stage and carries that stage's own result, so the decision log can show which
 * check turned the trade away and by how much.
 *
 * The engine still owns what happens next: submitting the order, tracking the fill, and updating the
 * portfolio state it passes back in.
 */

import { type BracketOrder, type BracketRejectionReason, buildBracket } from "./brackets.js";
import { type CostToRiskConfig, type CostToRiskRejection, evaluateCostToRisk } from "./costToRisk.js";
import type { CostModelConfig, Quote } from "./costs.js";
import type { Fixed } from "./money.js";
import { type PortfolioState, type RiskConfig, type RiskVeto, evaluateOrder } from "./riskRules.js";
import type { TradePlan } from "./setup.js";
import { type SizedPosition, type SizingConfig, type SizingRejection, sizePosition } from "./sizing.js";

export interface DecisionConfig {
  readonly costModel: CostModelConfig;
  readonly costToRisk: CostToRiskConfig;
  readonly sizing: SizingConfig;
  readonly risk: RiskConfig;
}

export interface DecisionInput {
  readonly plan: TradePlan;
  /** The NBBO the gate prices the round trip at. */
  readonly quote: Quote;
  readonly portfolio: PortfolioState;
  /** What the account may spend on this position. Self-imposed leverage is applied by the caller. */
  readonly buyingPower: Fixed;
}

export type EntryRefusal =
  | { readonly stage: "costToRisk"; readonly result: CostToRiskRejection }
  | { readonly stage: "sizing"; readonly result: SizingRejection }
  | { readonly stage: "risk"; readonly result: RiskVeto }
  | { readonly stage: "bracket"; readonly reasons: readonly BracketRejectionReason[] };

export interface EntryApproval {
  readonly approved: true;
  readonly order: BracketOrder;
  readonly sized: SizedPosition;
  /** Per share, from the gate. What sizing rejected against. */
  readonly costPerShare: Fixed;
}

export type EntryDecision = EntryApproval | ({ readonly approved: false } & EntryRefusal);

/** Runs the four stages. Throws only what a stage throws on a bad config, which is a bug. */
export function decideEntry(input: DecisionInput, config: DecisionConfig): EntryDecision {
  const { plan, quote, portfolio, buyingPower } = input;
  const { signal, stop } = plan;
  const stopDistance = (signal.direction === "long" ? signal.entry - stop : stop - signal.entry) as Fixed;

  const gate = evaluateCostToRisk({ quote, stopDistance }, config.costToRisk, config.costModel);
  if (!gate.passed) {
    return { approved: false, stage: "costToRisk", result: gate };
  }

  const sized = sizePosition(
    {
      direction: signal.direction,
      entry: signal.entry,
      stop,
      equity: portfolio.account.equity,
      buyingPower,
      roundTripCostPerShare: gate.costPerShare,
    },
    config.sizing,
  );
  if (!sized.accepted) {
    return { approved: false, stage: "sizing", result: sized };
  }

  const verdict = evaluateOrder(
    {
      intent: "entry",
      symbol: signal.symbol,
      direction: signal.direction,
      shares: sized.shares,
      entry: signal.entry,
      stop,
    },
    portfolio,
    config.risk,
  );
  if (!verdict.allowed) {
    return { approved: false, stage: "risk", result: verdict };
  }

  const bracket = buildBracket({ plan, shares: sized.shares });
  if (!bracket.ok) {
    return { approved: false, stage: "bracket", reasons: bracket.reasons };
  }
  return { approved: true, order: bracket.order, sized, costPerShare: gate.costPerShare };
}
