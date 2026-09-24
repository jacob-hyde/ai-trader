/**
 * Reads the pre-registration (Docs/Pre-Registration.md). It is the registration, so the runner reads the
 * committed file and never a copy of its numbers.
 *
 * Two things come out of it. The thresholds are section 11's JSON block: the samples, the sessions taken
 * out of the calendar, the strategy, the statistics, and every gate. The frozen configuration is the
 * holdout addendum (section 4), which does not exist until the in-sample verdict is in: a ```json block
 * anywhere in the file whose object holds "frozenConfiguration", the exact run configuration the holdout
 * runs, and "inSample", the in-sample numbers the holdout gates compare against (Amendment 6), and
 * nothing else. Until that block is committed, no run may touch a holdout session (guard.ts).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type RunConfig, parseRunConfig } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const REGISTRATION_PATH = path.join(REPO_ROOT, "Docs/Pre-Registration.md");
/** The frozen ETF and ETN exclusion list (section 3). */
export const EXCLUSIONS_PATH = path.join(REPO_ROOT, "Docs/ETF-ETN-Exclusions.txt");

const sessionDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The parts of section 11 a run reads. Everything else passes through for L.2 and EPIC-O. */
const thresholdsSchema = z
  .object({
    version: z.number().int().positive(),
    registered: sessionDate,
    samples: z.object({
      inSample: z.object({ from: sessionDate, to: sessionDate, firstTradable: sessionDate }),
      holdout: z.object({ from: sessionDate, to: sessionDate }),
      excludedSessions: z.array(sessionDate),
      // The bad-tick filter between the store and the broker, and when a symbol-session is corrupted.
      badTicks: z.object({
        maxExcursion: z.number(),
        maxExcursionRanges: z.number().int(),
        rangeBars: z.number().int(),
        maxCutsPerSession: z.number().int(),
      }),
    }),
    strategy: z.object({
      setup: z.literal("orb"),
      direction: z.literal("long"),
      priceMin: z.number(),
      priceMax: z.number(),
      minAverageVolume: z.number(),
      minDailyAtr: z.number(),
      lookbackSessions: z.number().int(),
      lookbackWindowSessions: z.number().int(),
      openingRangeMinutes: z.number().int(),
      minOpeningRvol: z.number(),
      topN: z.number().int(),
      topNChoices: z.array(z.number().int().positive()).min(1),
      stop: z.object({ kind: z.literal("openingRange") }),
      exits: z.array(z.object({ id: z.string() }).passthrough()).min(1),
      lastEntryMinutesBeforeClose: z.number().int(),
      flattenMinutesBeforeClose: z.number().int(),
      maxCostToRisk: z.number(),
      excludeEtfs: z.boolean(),
    }),
    statistics: z.object({
      method: z.literal("dayClusteredBootstrap"),
      resamples: z.number().int().min(2),
      seed: z.number().int(),
      familyAlpha: z.number().positive().max(1),
      correction: z.literal("holm"),
      sided: z.literal("one"),
    }),
    inSampleGates: z.object({
      minTrades: z.number().int().positive(),
      minPositiveYears: z.number().int().positive(),
      years: z.number().int().positive(),
      leaveOneYearOutPositive: z.boolean(),
      excludedRegimeYears: z.array(z.number().int()),
      excludedRegimeMeanPositive: z.boolean(),
    }),
    holdoutGates: z.object({ meanPositive: z.literal(true), notWorseZ: z.number().positive() }),
    live: z
      .object({
        aggressivePosture: z.object({
          riskPerTrade: z.number().positive(),
          maxPositionPct: z.number().positive(),
          maxConcurrent: z.number().int().positive(),
          dailyLossLimit: z.number().positive(),
        }),
      })
      .passthrough(),
    // The as-deployed diagnostic's account beyond the aggressive posture (section 7, Amendment 6).
    asDeployed: z.object({
      startingCash: z.number().positive(),
      maxGrossExposure: z.number().positive(),
      maxOpenRisk: z.number().positive(),
      flattenOnBreaker: z.boolean(),
    }),
    // Section 7's cost multiples, RVOL buckets, and the break-even search's ceiling (Amendment 6).
    diagnostics: z.object({
      costScales: z.array(z.number().positive()).min(1),
      rvolBuckets: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).min(1),
      breakEvenMaxBps: z.number().int().positive(),
    }),
    // What a passing null model is (Amendment 5). The gate's code is held to it by a test.
    nullModel: z.object({
      paths: z.number().int().positive(),
      firstSeed: z.number().int(),
      exits: z.array(z.string()).min(1),
      minTrades: z.number().int().positive(),
      grossToleranceR: z.number().nonnegative(),
      cleanCheckout: z.literal(true),
    }),
  })
  .passthrough();

export type Thresholds = z.infer<typeof thresholdsSchema>;

/** The in-sample numbers the holdout addendum carries beside the frozen configuration. */
const inSampleSchema = z
  .object({
    runId: z.string().uuid(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    exit: z.string().min(1),
    topN: z.number().int().positive(),
    trades: z.number().int().positive(),
    /** In R. */
    netMeanR: z.number(),
  })
  .strict();

export type FrozenInSample = z.infer<typeof inSampleSchema>;

export interface Registration {
  readonly thresholds: Thresholds;
  /** The holdout's configuration once the addendum is committed, else null. */
  readonly frozen: RunConfig | null;
  /** The in-sample numbers committed with it, else null. */
  readonly frozenInSample: FrozenInSample | null;
  /** Of the whole file, so a run records exactly which text it ran under. */
  readonly sha256: string;
  /** The frozen ETF and ETN exclusion list, or null before it exists. */
  readonly etfExclusions: readonly Exclusion[] | null;
}

/** One entry of the exclusion list: a symbol, for all its history or only from a session on. */
export interface Exclusion {
  readonly symbol: string;
  /** Null for all of its history. */
  readonly from: string | null;
}

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

/** Every ```json block, in order, with where it starts. */
function jsonBlocks(markdown: string): Array<{ readonly at: number; readonly text: string }> {
  return [...markdown.matchAll(/^```json\n([\s\S]*?)\n```$/gm)].map((match) => ({
    at: match.index,
    text: match[1] as string,
  }));
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RegistrationError(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Parses the registration's text. Throws RegistrationError when section 11 or an addendum is malformed. */
export function parseRegistration(markdown: string): Registration {
  const section = markdown.search(/^## 11\. /m);
  if (section === -1) {
    throw new RegistrationError("no section 11 (thresholds)");
  }
  const blocks = jsonBlocks(markdown);
  const block = blocks.find((b) => b.at > section);
  if (block === undefined) {
    throw new RegistrationError("section 11 has no json block");
  }
  const parsed = thresholdsSchema.safeParse(parseJson(block.text, "section 11"));
  if (!parsed.success) {
    throw new RegistrationError(
      `section 11: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  const addenda = blocks
    .map((b) => parseJson(b.text, "a json block"))
    .filter(
      (value): value is { frozenConfiguration: unknown } =>
        value !== null && typeof value === "object" && "frozenConfiguration" in value,
    );
  if (addenda.length > 1) {
    throw new RegistrationError("more than one frozen configuration; the holdout runs once, on one");
  }
  let frozen: RunConfig | null = null;
  let frozenInSample: FrozenInSample | null = null;
  const addendum = addenda[0] as Record<string, unknown> | undefined;
  if (addendum !== undefined) {
    if (Object.keys(addendum).some((key) => key !== "frozenConfiguration" && key !== "inSample")) {
      throw new RegistrationError(
        'the frozen configuration block holds "frozenConfiguration" and "inSample" and nothing else',
      );
    }
    try {
      frozen = parseRunConfig(addendum["frozenConfiguration"]);
    } catch (error) {
      throw new RegistrationError(`frozen configuration: ${(error as Error).message}`);
    }
    if (addendum["inSample"] !== undefined) {
      const inSample = inSampleSchema.safeParse(addendum["inSample"]);
      if (!inSample.success) {
        throw new RegistrationError(
          `frozen in-sample numbers: ${inSample.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      frozenInSample = inSample.data;
    }
  }
  return {
    thresholds: parsed.data,
    frozen,
    frozenInSample,
    sha256: createHash("sha256").update(markdown).digest("hex"),
    etfExclusions: null,
  };
}

/**
 * The exclusion list's entries: "SYMBOL" or "SYMBOL from YYYY-MM-DD" a line, anything after a # a
 * comment. Throws on any other line or a symbol listed twice, since either means the file was edited
 * by hand after its review.
 */
export function parseExclusions(text: string): Exclusion[] {
  const lines = text
    .split("\n")
    .map((line) => (line.split("#")[0] ?? "").trim())
    .filter((line) => line.length > 0);
  const entries: Exclusion[] = [];
  const malformed: string[] = [];
  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9.]*)(?: from (\d{4}-\d{2}-\d{2}))?$/.exec(line);
    if (match === null) {
      malformed.push(line);
    } else {
      entries.push({ symbol: match[1] as string, from: match[2] ?? null });
    }
  }
  if (malformed.length > 0) {
    throw new RegistrationError(`exclusion list: not an entry: ${malformed.join(", ")}`);
  }
  const symbols = entries.map((entry) => entry.symbol);
  const twice = symbols.filter((symbol, i) => symbols.indexOf(symbol) !== i);
  if (twice.length > 0) {
    throw new RegistrationError(`exclusion list: listed twice: ${twice.join(", ")}`);
  }
  return entries;
}

export async function loadRegistration(
  file = REGISTRATION_PATH,
  exclusions = EXCLUSIONS_PATH,
): Promise<Registration> {
  const registration = parseRegistration(await readFile(file, "utf8"));
  let text: string | null = null;
  try {
    text = await readFile(exclusions, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { ...registration, etfExclusions: text === null ? null : parseExclusions(text) };
}
