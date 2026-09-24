/**
 * A backtest run's configuration: what a job carries and what the run row stores.
 *
 * Human units on the way in (dollars, fractions, basis points), converted once here. Nothing has a
 * default except `blind` and the exclusion list, so the stored configuration says everything the run
 * did and two runs can be compared field by field.
 *
 * A run measures one or more variants of ORB on the same replay. Variants differ only in stop and exit,
 * so every variant sees the same signals, and with account "perSignal" they never interact: each signal
 * is its own trade. That is how the pre-registration's confirmatory test measures (section 5). With
 * account "asDeployed" the variants would share one account, so that mode takes exactly one.
 */

import type { Fixed, Ratio, SessionDate } from "@trader/contracts";
import {
  type BadTickConfig,
  type CostModelConfig,
  DEFAULT_BAD_TICK_CONFIG,
  DEFAULT_MAX_CUTS_PER_SESSION,
  assertBadTickConfig,
  type CostToRiskConfig,
  type DecisionConfig,
  type OrbParams,
  type Setup,
  assertCostModelConfig,
  assertCostToRiskConfig,
  assertRiskConfig,
  assertSizingConfig,
  fromNumber,
  loadSetup,
  noCommission,
  orbSetupDefinition,
  ratio,
} from "@trader/core";
import { z } from "zod";

const sessionDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a session is YYYY-MM-DD");
const fraction = z.number().positive().max(1);
const allowance = z
  .object({ bps: z.number().int().min(0).max(1_000), ticks: z.number().int().min(0).max(100) })
  .strict();

const universeSchema = z
  .object({
    /** Prior close, dollars, inclusive both ends. */
    priceMin: z.number().positive(),
    priceMax: z.number().positive(),
    /** Mean daily volume over the lookback, shares, strictly above. */
    minAverageVolume: z.number().min(0),
    /** Daily ATR, dollars, strictly above. */
    minDailyAtr: z.number().min(0),
    lookbackSessions: z.number().int().min(1).max(60),
    /** The lookback's sessions must all sit inside this many calendar sessions before the one traded. */
    lookbackWindowSessions: z.number().int().min(1).max(250),
    openingRangeMinutes: z.number().int().min(1).max(30),
    /** Opening RVOL must be strictly above this multiple. 1 is 100%. */
    minOpeningRvol: z.number().min(0).max(100),
    topN: z.number().int().min(1).max(1_000),
    /**
     * Never ranked, e.g. the pre-registration's ETF and ETN list. A symbol alone is excluded for all its
     * history; with `from`, only from that session on, for a ticker a fund took over from a company.
     */
    excludeSymbols: z
      .array(
        z.union([z.string().min(1), z.object({ symbol: z.string().min(1), from: sessionDate }).strict()]),
      )
      .default([]),
  })
  .strict()
  .refine((u) => u.priceMin < u.priceMax, { message: "priceMin must be below priceMax" })
  .refine((u) => u.lookbackWindowSessions >= u.lookbackSessions, {
    message: "lookbackWindowSessions cannot be shorter than lookbackSessions",
  });

const variantSchema = z
  .object({
    /** Letters and digits, so it fits a client order id. */
    id: z.string().regex(/^[A-Za-z0-9]{1,12}$/, "a variant id is 1 to 12 letters or digits"),
    /** ORB's stop and exit, as its parameter schema takes them. Checked by loading the setup. */
    stop: z.unknown(),
    exit: z.unknown(),
  })
  .strict();

const accountSchema = z.discriminatedUnion("kind", [
  // Every signal trades a fixed size with no account rule in the way (Pre-Registration section 5).
  z.object({ kind: z.literal("perSignal"), shares: z.number().int().min(1).max(1_000_000) }).strict(),
  // One account through sizing and the risk rules (section 7, "as deployed").
  z
    .object({
      kind: z.literal("asDeployed"),
      startingCash: z.number().positive().max(100_000_000),
      riskPerTrade: fraction,
      maxPositionPct: fraction,
      maxGrossExposure: z.number().positive().max(4),
      maxConcurrentPositions: z.number().int().min(1).max(20),
      maxOpenRisk: fraction,
      dailyLossLimit: fraction,
      flattenOnBreaker: z.boolean(),
      /** The validation regime's micro caps, or null for the proven regime. */
      micro: z
        .object({ maxShares: z.number().int().min(1), maxNotional: z.number().positive() })
        .strict()
        .nullable(),
    })
    .strict(),
]);

const baseSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** First and last session, inclusive. */
    from: sessionDate,
    to: sessionDate,
    universe: universeSchema,
    /** Also trade the bearish range short. A diagnostic in the pre-registration, never confirmatory. */
    shorts: z.boolean(),
    variants: z.array(variantSchema).min(1).max(12),
    session: z
      .object({
        /** An entry can fill only on bars before this many minutes before the close. */
        lastEntryMinutesBeforeClose: z.number().int().min(1).max(389),
        /** Open positions go out at the open of the first bar this many minutes before the close. */
        flattenMinutesBeforeClose: z.number().int().min(1).max(389),
      })
      .strict()
      .refine((s) => s.lastEntryMinutesBeforeClose > s.flattenMinutesBeforeClose, {
        message: "the entry cutoff must come before the flatten",
      }),
    costs: z
      .object({
        spread: z
          .object({ bps: z.number().int().min(0).max(1_000), minTicks: z.number().int().min(0) })
          .strict(),
        market: allowance,
        stopEntry: allowance,
        stopExit: allowance,
      })
      .strict(),
    /** Round-trip cost over stop distance at or below this passes the gate. 0.15 is 0.15R. */
    maxCostToRisk: fraction,
    /**
     * The bad-tick filter (H.8) between the store and the broker, or null to replay bars as stored. A
     * high or low past both its bar's body and the last close by more than maxExcursion (0.20 is 20%),
     * or maxExcursionRanges average minute ranges over the last rangeBars bars if that is further, is
     * cut back to the body.
     */
    badTicks: z
      .object({
        // At least 10%, so every cut falls inside the store's wide-wick candidates (pnpm bars suspects).
        maxExcursion: z.number().min(0.1).max(1),
        maxExcursionRanges: z.number().int().min(0).max(100),
        rangeBars: z.number().int().min(1).max(390),
        /** More cuts than this in one symbol-session and the session is left out whole, as corrupted. */
        maxCutsPerSession: z.number().int().min(0).max(780),
      })
      .strict()
      .nullable(),
    account: accountSchema,
    /** Carried for the statistics that resample the result (L.2). Nothing in a replay is random. */
    seed: z.number().int(),
    /** Run everything, keep nothing after 09:35 (see run.ts). */
    blind: z.boolean().default(false),
  })
  .strict();

export type RunConfigInput = z.input<typeof baseSchema>;
export type RunConfig = z.output<typeof baseSchema>;
export type VariantConfig = RunConfig["variants"][number];

/** ORB's parameters for one variant. The universe's gates and the session cutoff are the setup's too. */
export function orbParamsFor(config: RunConfig, variant: VariantConfig): Record<string, unknown> {
  const { universe } = config;
  return {
    openingRangeMinutes: universe.openingRangeMinutes,
    minOpeningRvol: universe.minOpeningRvol,
    minDailyAtr: universe.minDailyAtr,
    allowShort: config.shorts,
    stop: variant.stop,
    exit: variant.exit,
    entryWindowMinutes: null,
    // A full day's cutoff. The engine moves it in on a half day.
    lastEntryMinute: 390 - config.session.lastEntryMinutesBeforeClose,
  };
}

export function loadVariant(config: RunConfig, variant: VariantConfig): Setup<OrbParams> {
  return loadSetup(orbSetupDefinition, orbParamsFor(config, variant));
}

export function costModelFor(config: RunConfig): CostModelConfig {
  const { spread, market, stopEntry, stopExit } = config.costs;
  const slippage = (a: { bps: number; ticks: number }) => ({ bps: ratio(a.bps), ticks: a.ticks });
  return {
    spread: { bps: ratio(spread.bps), minTicks: spread.minTicks },
    slippage: { market: slippage(market), stopEntry: slippage(stopEntry), stopExit: slippage(stopExit) },
    commission: noCommission,
  };
}

/** Basis points from a plain multiple or fraction, the way ORB's parameter schema converts them. */
export function toRatio(value: number): Ratio {
  return ratio(Math.round(value * 10_000));
}

export function costToRiskFor(config: RunConfig): CostToRiskConfig {
  return { maxCostToRisk: toRatio(config.maxCostToRisk), entryKind: "stopEntry", exitKind: "stopExit" };
}

/** Sizing and the risk rules for an as-deployed run. */
export function decisionFor(config: RunConfig): DecisionConfig | null {
  const { account } = config;
  if (account.kind !== "asDeployed") {
    return null;
  }
  return {
    costModel: costModelFor(config),
    costToRisk: costToRiskFor(config),
    sizing: {
      riskPerTrade: toRatio(account.riskPerTrade),
      maxPositionPct: toRatio(account.maxPositionPct),
      regime:
        account.micro === null
          ? { kind: "proven" }
          : {
              kind: "validation",
              maxShares: account.micro.maxShares,
              maxNotional: fromNumber(account.micro.maxNotional),
            },
    },
    risk: {
      maxPositionPct: toRatio(account.maxPositionPct),
      maxGrossExposure: toRatio(account.maxGrossExposure),
      maxConcurrentPositions: account.maxConcurrentPositions,
      maxOpenRisk: toRatio(account.maxOpenRisk),
      dailyLossLimit: toRatio(account.dailyLossLimit),
      flattenOnBreaker: account.flattenOnBreaker,
    },
  };
}

/** Cash the simulated broker starts with. Per signal it is large enough that no order ever waits on it. */
/** The filter's settings in core's units, or null when it is off. */
export function badTickConfigFor(config: RunConfig): BadTickConfig | null {
  const { badTicks } = config;
  return badTicks === null
    ? null
    : {
        maxExcursion: toRatio(badTicks.maxExcursion),
        maxExcursionRanges: badTicks.maxExcursionRanges,
        rangeBars: badTicks.rangeBars,
      };
}

/** Core's default filter, in a run configuration's units. */
export const DEFAULT_BAD_TICKS: NonNullable<RunConfig["badTicks"]> = {
  maxExcursion: DEFAULT_BAD_TICK_CONFIG.maxExcursion / 10_000,
  maxExcursionRanges: DEFAULT_BAD_TICK_CONFIG.maxExcursionRanges,
  rangeBars: DEFAULT_BAD_TICK_CONFIG.rangeBars,
  maxCutsPerSession: DEFAULT_MAX_CUTS_PER_SESSION,
};

export function startingCashFor(config: RunConfig): Fixed {
  return fromNumber(config.account.kind === "asDeployed" ? config.account.startingCash : 1_000_000_000);
}

/** Checks that only running the pieces can do: each variant loads, and the costs and rules pass core's bounds. */
function checkPieces(config: RunConfig, ctx: z.RefinementCtx): void {
  const problem = (path: (string | number)[], error: unknown) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  if (config.from > config.to) {
    problem(["to"], new Error(`from ${config.from} is after to ${config.to}`));
  }
  const ids = config.variants.map((variant) => variant.id);
  if (new Set(ids).size !== ids.length) {
    problem(["variants"], new Error("variant ids must be unique"));
  }
  if (config.account.kind === "asDeployed" && config.variants.length !== 1) {
    problem(
      ["variants"],
      new Error("an as-deployed run shares one account, so it takes exactly one variant"),
    );
  }
  config.variants.forEach((variant, i) => {
    try {
      loadVariant(config, variant);
    } catch (error) {
      problem(["variants", i], error);
    }
  });
  try {
    assertCostModelConfig(costModelFor(config));
    const badTicks = badTickConfigFor(config);
    if (badTicks !== null) {
      assertBadTickConfig(badTicks);
    }
    assertCostToRiskConfig(costToRiskFor(config));
  } catch (error) {
    problem(["costs"], error);
  }
  const decision = decisionFor(config);
  if (decision !== null) {
    try {
      assertSizingConfig(decision.sizing);
      assertRiskConfig(decision.risk);
    } catch (error) {
      problem(["account"], error);
    }
  }
}

export const runConfigSchema = baseSchema.superRefine(checkPieces);

/** Parses a run configuration. Throws a ZodError naming every problem. */
export function parseRunConfig(raw: unknown): RunConfig {
  return runConfigSchema.parse(raw);
}

/** The same configuration always prints the same, key order included, so two can be compared as text. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export type { SessionDate };
