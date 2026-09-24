import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { canonical, parseRunConfig } from "./config.js";
import { readGit } from "./git.js";
import { checkRunAllowed } from "./guard.js";
import { preregisteredConfig } from "./preregistered.js";
import { REGISTRATION_PATH, RegistrationError, loadRegistration, parseRegistration } from "./registration.js";
import { testConfig } from "./testing.js";

const REAL = readFileSync(REGISTRATION_PATH, "utf8");

/** The real file with extra text after the amendments. */
const withAddendum = (text: string) => `${REAL}\n### Addendum\n\n${text}\n`;
const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

describe("the registration", () => {
  it("reads section 11 of the committed file: version 3, 2022-03-08 out, the bad-tick filter, nothing frozen", async () => {
    const registration = await loadRegistration();
    expect(registration.thresholds.version).toBe(3);
    expect(registration.thresholds.samples).toEqual({
      inSample: { from: "2016-01-04", to: "2023-12-29", firstTradable: "2016-01-25" },
      holdout: { from: "2024-01-02", to: "2026-08-31" },
      excludedSessions: ["2022-03-08"],
      badTicks: { maxExcursion: 0.2, maxExcursionRanges: 10, rangeBars: 30, maxCutsPerSession: 5 },
    });
    expect(registration.thresholds.strategy.topN).toBe(20);
    expect(registration.frozen).toBeNull();
    expect(registration.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds a frozen configuration in an addendum and holds it to the run schema", () => {
    const frozen = testConfig({ name: "frozen" });
    const registration = parseRegistration(withAddendum(block({ frozenConfiguration: frozen })));
    expect(canonical(registration.frozen)).toBe(canonical(frozen));
    expect(registration.sha256).not.toBe(parseRegistration(REAL).sha256);
  });

  it("refuses a malformed registration rather than guessing", () => {
    expect(() => parseRegistration("# nothing")).toThrow(/no section 11/);
    expect(() => parseRegistration("## 11. Thresholds\n\nnone")).toThrow(/no json block/);
    expect(() => parseRegistration(REAL.replace('"version": 3', '"version": "three"'))).toThrow(
      /section 11: version/,
    );
    expect(() => parseRegistration(REAL.replace('"version": 3,', '"version": 3,,'))).toThrow(
      /not valid JSON/,
    );
    const frozen = { frozenConfiguration: testConfig() };
    expect(() => parseRegistration(withAddendum(`${block(frozen)}\n\n${block(frozen)}`))).toThrow(
      /more than one frozen/,
    );
    expect(() => parseRegistration(withAddendum(block({ ...frozen, note: "x" })))).toThrow(/nothing else/);
    expect(() => parseRegistration(withAddendum(block({ frozenConfiguration: { name: "x" } })))).toThrow(
      RegistrationError,
    );
  });
});

describe("run configuration", () => {
  const good = () => JSON.parse(JSON.stringify(testConfig())) as Record<string, unknown>;

  it("fills in only blind and the exclusion list, and prints the same whatever the key order", () => {
    const raw = good();
    delete raw["blind"];
    delete (raw["universe"] as Record<string, unknown>)["excludeSymbols"];
    const parsed = parseRunConfig(raw);
    expect([parsed.blind, parsed.universe.excludeSymbols]).toEqual([false, []]);
    const reordered = Object.fromEntries(Object.entries(good()).reverse());
    expect(canonical(parseRunConfig(reordered))).toBe(canonical(parsed));
  });

  it("names every problem a run would otherwise meet at 09:35", () => {
    const issues = (raw: Record<string, unknown>): string => {
      try {
        parseRunConfig(raw);
        return "";
      } catch (error) {
        return (error as ZodError).issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      }
    };
    const variants = good()["variants"] as unknown[];
    expect(issues({ ...good(), from: "2026-03-01" })).toMatch(/to: from 2026-03-01 is after to/);
    expect(issues({ ...good(), variants: [variants[0], variants[0]] })).toMatch(/unique/);
    expect(
      issues({ ...good(), variants: [{ id: "X", stop: { kind: "wide" }, exit: { kind: "eod" } }] }),
    ).toMatch(/variants.0: setup "orb": stop/);
    expect(issues({ ...good(), account: asDeployed })).toMatch(/exactly one variant/);
    expect(
      issues({ ...good(), session: { lastEntryMinutesBeforeClose: 10, flattenMinutesBeforeClose: 10 } }),
    ).toMatch(/cutoff must come before the flatten/);
    expect(
      issues({ ...good(), costs: { ...(good()["costs"] as object), stopEntry: { bps: 0, ticks: 0 } } }),
    ).toMatch(/costs:/);
    expect(issues({ ...good(), extra: 1 })).toMatch(/Unrecognized key/);
    expect(() => parseRunConfig({ ...good(), seed: 1.5 })).toThrow(ZodError);
  });
});

const asDeployed = {
  kind: "asDeployed",
  startingCash: 2_500,
  riskPerTrade: 0.015,
  maxPositionPct: 0.25,
  maxGrossExposure: 1,
  maxConcurrentPositions: 4,
  maxOpenRisk: 0.02,
  dailyLossLimit: 0.05,
  flattenOnBreaker: false,
  micro: null,
} as const;

describe("the pre-registered configuration", () => {
  it("is section 11's strategy: the confirmatory pair, the ATR diagnostics, shorts, default costs", async () => {
    const registration = await loadRegistration();
    const config = preregisteredConfig(registration.thresholds, {
      excludeSymbols: ["SPY", "QQQ"],
      blind: true,
    });
    expect(config).toMatchObject({
      name: "L.2 in-sample, registration v3",
      from: "2016-01-04",
      to: "2023-12-29",
      universe: {
        priceMin: 5,
        priceMax: 100,
        minAverageVolume: 1_000_000,
        minDailyAtr: 0.5,
        lookbackSessions: 14,
        lookbackWindowSessions: 20,
        openingRangeMinutes: 5,
        minOpeningRvol: 1,
        topN: 20,
        excludeSymbols: ["SPY", "QQQ"],
      },
      shorts: true,
      session: { lastEntryMinutesBeforeClose: 30, flattenMinutesBeforeClose: 10 },
      maxCostToRisk: 0.15,
      badTicks: { maxExcursion: 0.2, maxExcursionRanges: 10, rangeBars: 30, maxCutsPerSession: 5 },
      account: { kind: "perSignal", shares: 1 },
      seed: 20260922,
      blind: true,
    });
    expect(config.variants).toEqual([
      { id: "A", stop: { kind: "openingRange" }, exit: { kind: "eod" } },
      { id: "B", stop: { kind: "openingRange" }, exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 } },
      { id: "atr10A", stop: { kind: "atrFraction", fraction: 0.1 }, exit: { kind: "eod" } },
      {
        id: "atr10B",
        stop: { kind: "atrFraction", fraction: 0.1 },
        exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 },
      },
      { id: "atr50A", stop: { kind: "atrFraction", fraction: 0.5 }, exit: { kind: "eod" } },
      {
        id: "atr50B",
        stop: { kind: "atrFraction", fraction: 0.5 },
        exit: { kind: "fixedR", targetR: 2, breakevenAtR: 1 },
      },
    ]);
    // In-sample only, so it needs no frozen configuration.
    expect(() => checkRunAllowed(config, registration, { commit: null, dirty: true })).not.toThrow();
  });
});

describe("git", () => {
  it("names the checkout's commit, and nothing outside one", async () => {
    const here = await readGit();
    expect(here.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await readGit(tmpdir())).toEqual({ commit: null, dirty: false });
  });
});
