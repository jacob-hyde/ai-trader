/**
 * Reads Round 2's pre-registration (Docs/Pre-Registration-Round-2.md): the round's thresholds in section 7,
 * and each study's own JSON block, written into its section before its first run.
 *
 * A study's block is a ```json block anywhere in the file whose object has "study" set to the study's
 * number. A study with no block is not registered, and nothing runs it.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./registration.js";

export const ROUND2_PATH = path.join(REPO_ROOT, "Docs/Pre-Registration-Round-2.md");

const sessionDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const roundSchema = z
  .object({
    round: z.literal(2),
    registered: sessionDate,
    studies: z.array(z.string()).min(1),
    familyAlpha: z.number().positive(),
    studyAlpha: z.number().positive(),
    samples: z.object({
      inSample: z.object({ from: sessionDate, to: sessionDate }),
      holdout: z.object({ from: sessionDate, to: sessionDate }),
      excludedSessions: z.array(sessionDate),
    }),
    statistics: z.object({
      method: z.literal("dayClusteredBootstrap"),
      resamples: z.number().int().min(2),
      seed: z.number().int(),
      sided: z.literal("one"),
    }),
    inSampleGates: z.object({
      minPositiveYears: z.number().int().positive(),
      years: z.number().int().positive(),
      leaveOneYearOutPositive: z.boolean(),
      excludedRegimeYears: z.array(z.number().int()),
      excludedRegimeMeanPositive: z.boolean(),
    }),
    holdoutGates: z.object({ meanPositive: z.literal(true), notWorseZ: z.number().positive() }),
    prices: z.object({
      latencyMs: z.number().int().nonnegative(),
      openingAuctionWindowMinutes: z.number().int().positive(),
      closingAuctionWindowMinutes: z.number().int().positive(),
      saleFeeBps: z.number().nonnegative(),
      maxUnpricedShare: z.number().min(0).max(1),
    }),
    shorts: z.object({ shortSaleTestDrop: z.number().positive(), borrowFee: z.number().nonnegative() }),
  })
  .refine((r) => Math.abs(r.studyAlpha * r.studies.length - r.familyAlpha) < 1e-9, {
    message: "studyAlpha times the number of studies must be the family alpha",
  });

export type Round2 = z.infer<typeof roundSchema>;

/** Study 2.1's block (section 5). */
export const gapFadeSpecSchema = z
  .object({
    study: z.literal("2.1"),
    registered: sessionDate,
    universe: z
      .object({
        priceMin: z.number().positive(),
        priceMax: z.number().positive(),
        minAverageVolume: z.number().positive(),
        lookbackSessions: z.number().int().positive(),
        lookbackWindowSessions: z.number().int().positive(),
      })
      .strict(),
    /** The gap at 09:25 must be at least this fraction of the prior close. */
    minGap: z.number().positive().max(1),
    /** An article naming the symbol in the overnight window disqualifies it. */
    maxArticles: z.literal(0),
    topN: z.number().int().positive(),
    minTrades: z.number().int().positive(),
  })
  .strict();

export type GapFadeSpec = z.infer<typeof gapFadeSpecSchema>;

export class Round2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Round2Error";
  }
}

export interface Round2Registration {
  readonly round: Round2;
  /** Each registered study's block, by study number, unparsed. */
  readonly studies: ReadonlyMap<string, unknown>;
  readonly sha256: string;
}

function blocks(markdown: string): Array<{ readonly at: number; readonly value: unknown }> {
  return [...markdown.matchAll(/^```json\n([\s\S]*?)\n```$/gm)].map((match) => {
    try {
      return { at: match.index, value: JSON.parse(match[1] as string) as unknown };
    } catch (error) {
      throw new Round2Error(`a json block is not valid JSON: ${(error as Error).message}`);
    }
  });
}

export function parseRound2(markdown: string): Round2Registration {
  const section = markdown.search(/^## 7\. /m);
  const all = blocks(markdown);
  const block = all.find((b) => b.at > section);
  if (section === -1 || block === undefined) {
    throw new Round2Error("no section 7 thresholds block");
  }
  const round = roundSchema.safeParse(block.value);
  if (!round.success) {
    throw new Round2Error(
      `section 7: ${round.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const studies = new Map<string, unknown>();
  for (const { value } of all) {
    if (value !== null && typeof value === "object" && "study" in value) {
      const id = String((value as { study: unknown }).study);
      if (studies.has(id)) {
        throw new Round2Error(`study ${id} is registered twice`);
      }
      if (!round.data.studies.includes(id)) {
        throw new Round2Error(`study ${id} is not one of the round's studies`);
      }
      studies.set(id, value);
    }
  }
  return { round: round.data, studies, sha256: createHash("sha256").update(markdown).digest("hex") };
}

export async function loadRound2(file = ROUND2_PATH): Promise<Round2Registration> {
  return parseRound2(await readFile(file, "utf8"));
}

/** Study 2.1's registered specification. Throws when it is not registered or does not parse. */
export function gapFadeSpec(registration: Round2Registration): GapFadeSpec {
  const raw = registration.studies.get("2.1");
  if (raw === undefined) {
    throw new Round2Error("study 2.1 is not registered: its section has no json block yet");
  }
  const parsed = gapFadeSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Round2Error(
      `study 2.1: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}
