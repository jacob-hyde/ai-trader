/**
 * Study 2.1's report as markdown. The verdict's means are percent of the entry, since its trades are in
 * millionths; here they print as basis points.
 */

import type { Round2 } from "../round2.js";
import type { GapFadeSpec } from "../round2.js";
import type { GapFadeRun } from "./run.js";
import type { Estimate } from "./study.js";

const bps = (percent: number | null | undefined) =>
  percent == null ? "n/a" : `${percent >= 0 ? "+" : ""}${(percent * 100).toFixed(1)} bps`;
const est = (e: Estimate) =>
  e.meanBps === null
    ? "no trades"
    : `${e.meanBps >= 0 ? "+" : ""}${e.meanBps.toFixed(1)} bps [${(e.lowerBps ?? 0).toFixed(1)}, ${(e.upperBps ?? 0).toFixed(1)}], ${e.trades.toLocaleString("en-US")} trades`;
const mark = (passed: boolean) => (passed ? "pass" : "FAIL");

/** Null when the run may report a verdict; otherwise why not. */
export function withheld(run: GapFadeRun, round: Round2): string | null {
  const total = run.result.priced + run.result.unpriced;
  const share = total === 0 ? 0 : run.result.unpriced / total;
  return share > round.prices.maxUnpricedShare
    ? `${(share * 100).toFixed(1)}% of trades had no auction print, over the ${String(round.prices.maxUnpricedShare * 100)}% allowed`
    : null;
}

export function renderGapFade(
  run: GapFadeRun,
  spec: GapFadeSpec,
  round: Round2,
  meta: { readonly commit: string | null; readonly registration: string },
): string {
  const v = run.result.verdict;
  const why = withheld(run, round);
  const lines = [
    "# Study 2.1: no-news overnight gap fade, in-sample",
    "",
    `Run ${run.id} on commit ${meta.commit?.slice(0, 8) ?? "none"}, Round 2 registration ${meta.registration.slice(0, 8)}. ${String(run.sessions)} sessions. Quiet gap-ups of at least ${String(spec.minGap * 100)}% by 09:25, top ${String(spec.topN)} a session, short on the opening auction, covered on the closing auction, one share, ${String(round.prices.saleFeeBps)} bps fee on the sale. ${String(run.restricted)} candidates left out under the short-sale price test.`,
    "",
    `Priced from the auction prints: ${run.result.priced.toLocaleString("en-US")}; without one: ${String(run.result.unpriced)}.`,
    "",
  ];
  if (why !== null) {
    return [...lines, `No verdict: ${why}.`, ""].join("\n");
  }
  lines.push(
    `## Verdict: ${v.outcome.toUpperCase()}`,
    "",
    "| Gate | Result |",
    "|---|---|",
    `| Trades (at least ${spec.minTrades.toLocaleString("en-US")}) | ${v.trades.toLocaleString("en-US")}, ${mark(v.gates.trades.passed)} |`,
    `| Net mean | ${bps(v.meanR)} |`,
    `| One-sided 99% bound, the 5th percentile shown | ${bps(v.bootstrap?.lower)} |`,
    `| Significance | p ${v.holm?.p.toFixed(4) ?? "n/a"} against ${String(round.studyAlpha)}, ${mark(v.gates.significance.passed)} |`,
    `| Years positive | ${v.gates.yearsPositive.detail}, ${mark(v.gates.yearsPositive.passed)} |`,
    `| No year carries it | ${mark(v.gates.leaveOneYearOut.passed)} |`,
    `| Not a 2020 to 2021 edge | ${mark(v.gates.excludedRegime.passed)} |`,
    "",
    "| Year | Trades | Net mean |",
    "|---|---|---|",
    ...v.years.map((y) => `| ${String(y.year)} | ${y.trades.toLocaleString("en-US")} | ${bps(y.meanR)} |`),
    "",
    "## Diagnostics",
    "",
    "Priced from each day's own bar, not the auction prints. Analytic day-clustered 95% intervals.",
    "",
    `- The same fade on gap-ups that had news: ${est(run.result.diagnostics.withNews)}.`,
    `- The mirror long on quiet gap-downs: ${est(run.result.diagnostics.gapDownLong)}.`,
    ...run.result.diagnostics.byGap.map(
      (b) =>
        `- Confirmatory trades with gaps ${String(b.from * 100)}% to ${b.to === null ? "any" : `${String(b.to * 100)}%`}: ${est(b.estimate)}.`,
    ),
    "",
  );
  return lines.join("\n");
}
