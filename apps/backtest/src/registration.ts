/**
 * Reads the pre-registration (Docs/Pre-Registration.md). It is the registration, so the runner reads the
 * committed file and never a copy of its numbers.
 *
 * Two things come out of it. The thresholds are section 11's JSON block: the samples, the sessions taken
 * out of the calendar, the strategy. The frozen configuration is the holdout addendum (section 4), which
 * does not exist until the in-sample verdict is in: a ```json block anywhere in the file whose object
 * has one key, "frozenConfiguration", holding the exact run configuration the holdout runs. Until that
 * block is committed, no run may touch a holdout session (guard.ts).
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
      stop: z.object({ kind: z.literal("openingRange") }),
      exits: z.array(z.object({ id: z.string() }).passthrough()).min(1),
      lastEntryMinutesBeforeClose: z.number().int(),
      flattenMinutesBeforeClose: z.number().int(),
      maxCostToRisk: z.number(),
      excludeEtfs: z.boolean(),
    }),
    statistics: z.object({ seed: z.number().int() }).passthrough(),
  })
  .passthrough();

export type Thresholds = z.infer<typeof thresholdsSchema>;

export interface Registration {
  readonly thresholds: Thresholds;
  /** The holdout's configuration once the addendum is committed, else null. */
  readonly frozen: RunConfig | null;
  /** Of the whole file, so a run records exactly which text it ran under. */
  readonly sha256: string;
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
  const addendum = addenda[0];
  if (addendum !== undefined) {
    if (Object.keys(addendum).length !== 1) {
      throw new RegistrationError(
        'the frozen configuration block holds "frozenConfiguration" and nothing else',
      );
    }
    try {
      frozen = parseRunConfig(addendum.frozenConfiguration);
    } catch (error) {
      throw new RegistrationError(`frozen configuration: ${(error as Error).message}`);
    }
  }
  return {
    thresholds: parsed.data,
    frozen,
    sha256: createHash("sha256").update(markdown).digest("hex"),
  };
}

export async function loadRegistration(file = REGISTRATION_PATH): Promise<Registration> {
  return parseRegistration(await readFile(file, "utf8"));
}
