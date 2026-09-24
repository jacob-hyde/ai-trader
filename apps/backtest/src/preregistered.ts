/**
 * The in-sample run the pre-registration describes, built from section 11 and nothing else.
 *
 * One replay measures everything section 7 asks of it per signal: the confirmatory pair (range-low stop,
 * exits A and B), the published 10% ATR stop and the 50% ATR stop as diagnostics on both exits, and the
 * short side. Each signal is its own trade (section 5), so the diagnostics cannot move the confirmatory
 * numbers, and every signal the cost gate rejects is still simulated and marked, for H3 and H4.
 *
 * Costs are the default model section 3 names. The cost-sensitivity and as-deployed runs are separate
 * runs with their own configuration, since they change the fills or share an account.
 *
 * The ETF and ETN exclusions are the frozen list (Docs/ETF-ETN-Exclusions.txt), never a list passed in.
 *
 * Building the configuration is not running L.2. The preconditions in section 3 (the ETF list committed,
 * H.8 in the replay, the null model passing on the same commit) are L.2's to check.
 */

import { type RunConfig, parseRunConfig } from "./config.js";
import { type Registration, RegistrationError } from "./registration.js";

export interface PreregisteredOptions {
  readonly blind: boolean;
}

/** Throws RegistrationError when the registration excludes ETFs and the frozen list does not exist yet. */
export function preregisteredConfig(registration: Registration, options: PreregisteredOptions): RunConfig {
  const { thresholds } = registration;
  const { samples, strategy } = thresholds;
  if (strategy.excludeEtfs && registration.etfExclusions === null) {
    throw new RegistrationError(
      "the registration excludes ETFs and ETNs, and the frozen list does not exist",
    );
  }
  const exits = strategy.exits.map(({ id, ...exit }) => ({ id, exit }));
  const variants = [
    ...exits.map(({ id, exit }) => ({ id, stop: strategy.stop, exit })),
    ...[0.1, 0.5].flatMap((fraction) =>
      exits.map(({ id, exit }) => ({
        id: `atr${String(Math.round(fraction * 100))}${id}`,
        stop: { kind: "atrFraction", fraction },
        exit,
      })),
    ),
  ];
  return parseRunConfig({
    name: `L.2 in-sample, registration v${String(thresholds.version)}`,
    from: samples.inSample.from,
    to: samples.inSample.to,
    universe: {
      priceMin: strategy.priceMin,
      priceMax: strategy.priceMax,
      minAverageVolume: strategy.minAverageVolume,
      minDailyAtr: strategy.minDailyAtr,
      lookbackSessions: strategy.lookbackSessions,
      lookbackWindowSessions: strategy.lookbackWindowSessions,
      openingRangeMinutes: strategy.openingRangeMinutes,
      minOpeningRvol: strategy.minOpeningRvol,
      topN: strategy.topN,
      excludeSymbols: strategy.excludeEtfs
        ? (registration.etfExclusions ?? []).map(({ symbol, from }) =>
            from === null ? symbol : { symbol, from },
          )
        : [],
    },
    shorts: true,
    variants,
    session: {
      lastEntryMinutesBeforeClose: strategy.lastEntryMinutesBeforeClose,
      flattenMinutesBeforeClose: strategy.flattenMinutesBeforeClose,
    },
    // Section 3, "Fills": spread 10 bps or a tick, market 2 bps or a tick, both stops 10 bps or two.
    costs: {
      spread: { bps: 10, minTicks: 1 },
      market: { bps: 2, ticks: 1 },
      stopEntry: { bps: 10, ticks: 2 },
      stopExit: { bps: 10, ticks: 2 },
    },
    maxCostToRisk: strategy.maxCostToRisk,
    // Section 3: the H.8 filter runs between the store and the broker (Amendment 3).
    badTicks: samples.badTicks,
    // R does not depend on size with no commission, so one share is every size.
    account: { kind: "perSignal", shares: 1 },
    seed: thresholds.statistics.seed,
    blind: options.blind,
  });
}

export type { RunConfig };
