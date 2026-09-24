import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUND2_PATH, Round2Error, gapFadeSpec, loadRound2, parseRound2 } from "./round2.js";

const REAL = readFileSync(ROUND2_PATH, "utf8");
const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const spec = {
  study: "2.1",
  registered: "2026-09-25",
  universe: {
    priceMin: 10,
    priceMax: 100,
    minAverageVolume: 1_000_000,
    lookbackSessions: 14,
    lookbackWindowSessions: 20,
  },
  minGap: 0.03,
  maxArticles: 0,
  topN: 3,
  minTrades: 1_500,
};

/** The real file without any study's block, for appending blocks to. */
const BARE = REAL.replace(/```json\n\{\n {2}"study"[\s\S]*?\n```/g, "");

describe("the round 2 registration", () => {
  it("reads the round's thresholds: five studies at 0.01 for a family of 0.05", async () => {
    const { round } = await loadRound2();
    expect(round.studies).toEqual(["2.1", "2.2", "2.3", "2.4", "2.5"]);
    expect([round.studyAlpha, round.familyAlpha]).toEqual([0.01, 0.05]);
    expect(round.samples.holdout.from).toBe("2024-01-02");
  });

  it("has study 2.1 registered as section 5 writes it", async () => {
    expect(gapFadeSpec(await loadRound2())).toEqual({ ...spec, registered: "2026-09-24", minTrades: 2_000 });
  });

  it("reads a study's block from its section, and refuses one registered twice or outside the round", () => {
    const registered = parseRound2(`${BARE}\n${block(spec)}\n`);
    expect(gapFadeSpec(registered)).toEqual(spec);
    expect(() => parseRound2(`${BARE}\n${block(spec)}\n${block(spec)}\n`)).toThrow(/registered twice/);
    expect(() => parseRound2(`${BARE}\n${block({ ...spec, study: "9.9" })}\n`)).toThrow(
      /not one of the round's/,
    );
    expect(() => gapFadeSpec(parseRound2(`${BARE}\n${block({ ...spec, topN: 0 })}\n`))).toThrow(Round2Error);
  });

  it("does not run a study that is not registered yet", () => {
    expect(() => gapFadeSpec(parseRound2(BARE))).toThrow(/not registered/);
  });
});
