/**
 * The L.2 reports as markdown, for the terminal and for the report row beside the JSON.
 */

import type { Estimate } from "./diagnostics.js";
import { type HoldoutReport, type InSampleReport, type Precondition, addendumBlock } from "./l2.js";
import type { VariantVerdict } from "./verdict.js";

const r = (value: number | null | undefined) =>
  value == null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}R`;
const n = (value: number) => value.toLocaleString("en-US");
const mark = (passed: boolean) => (passed ? "pass" : "FAIL");
const est = (e: Estimate) =>
  e.meanR === null ? `no trades` : `${r(e.meanR)} [${r(e.lower)}, ${r(e.upper)}], ${n(e.trades)} trades`;

function preconditionTable(checks: readonly Precondition[]): string[] {
  return [
    "## Preconditions",
    "",
    "| Precondition | | Detail |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${mark(c.passed)} | ${c.detail} |`),
    "",
  ];
}

function gateTable(verdicts: readonly VariantVerdict[]): string[] {
  const row = (label: string, cell: (v: VariantVerdict) => string) =>
    `| ${label} | ${verdicts.map(cell).join(" | ")} |`;
  return [
    `| Gate | ${verdicts.map((v) => `Exit ${v.id}`).join(" | ")} |`,
    `|---|${verdicts.map(() => "---|").join("")}`,
    row("Trades", (v) => `${n(v.trades)}, ${mark(v.gates.trades.passed)}`),
    row("Net mean R", (v) => r(v.meanR)),
    row("One-sided 95% lower bound", (v) => r(v.bootstrap?.lower)),
    row("Significance", (v) => `${v.gates.significance.detail}, ${mark(v.gates.significance.passed)}`),
    row("Years positive", (v) => `${v.gates.yearsPositive.detail}, ${mark(v.gates.yearsPositive.passed)}`),
    row(
      "No year carries it",
      (v) => `${v.gates.leaveOneYearOut.detail}, ${mark(v.gates.leaveOneYearOut.passed)}`,
    ),
    row(
      "Not a 2020 to 2021 edge",
      (v) => `${v.gates.excludedRegime.detail}, ${mark(v.gates.excludedRegime.passed)}`,
    ),
    row("Outcome", (v) => v.outcome.toUpperCase()),
    "",
  ];
}

export function renderInSampleReport(report: InSampleReport): string {
  const lines = [
    "# L.2 in-sample verdict",
    "",
    `Run ${report.runId} on commit ${report.commit?.slice(0, 8) ?? "none"}, registration version ${String(report.registration.version)} (${report.registration.sha256.slice(0, 8)}), data ${report.dataSnapshot ?? "unknown"}.`,
    "",
    ...preconditionTable(report.preconditions),
  ];
  const result = report.result;
  if (result === null) {
    return [...lines, "No verdict: a precondition failed. Nothing this run measured is reported.", ""].join(
      "\n",
    );
  }
  const d = result.diagnostics;
  lines.push(
    `## Verdict: ${result.outcome}${result.outcome === "EDGE CANDIDATE" ? " (the holdout decides)" : ""}`,
    "",
    ...gateTable(result.exits),
    "Top 10 alone, for section 4's rule:",
    "",
    ...gateTable(result.topTen),
  );
  if (result.frozen !== null) {
    lines.push(
      `Frozen configuration: exit ${result.frozen.exit}, top ${String(result.frozen.topN)}. ${result.frozen.reason}.`,
      "",
    );
  }
  const years = result.exits[0]?.years.map((y) => y.year) ?? [];
  lines.push(
    "## Year by year",
    "",
    `| Year | ${result.exits.map((v) => `${v.id} trades | ${v.id} mean | ${v.id} total`).join(" | ")} |`,
    `|---|${result.exits.map(() => "---|---|---|").join("")}`,
    ...years.map(
      (year) =>
        `| ${String(year)} | ${result.exits
          .map((v) => {
            const y = v.years.find((row) => row.year === year);
            return `${n(y?.trades ?? 0)} | ${r(y?.meanR)} | ${r(y?.totalR)}`;
          })
          .join(" | ")} |`,
    ),
    "",
    "## Diagnostics (section 7)",
    "",
    "Intervals here are analytic day-clustered 95%. None of these gates the verdict.",
    "",
    "| Diagnostic | Exit | Net mean R |",
    "|---|---|---|",
    ...d.gate.flatMap((g) => [
      `| H3: the gate passed | ${g.exit} | ${est(g.passed)} |`,
      `| H3: the gate rejected | ${g.exit} | ${est(g.rejected)} |`,
    ]),
    ...d.publishedStop.map(
      (p) =>
        `| H4: 10% ATR stop, gate off (${n(p.gatePassed)} of ${n(p.signals)} passed it) | ${p.exit} | ${est(p.estimate)} |`,
    ),
    ...d.atr50.map((a) => `| 50% ATR stop, gate on | ${a.exit} | ${est(a.estimate)} |`),
    ...d.rvolBuckets.flatMap((b) =>
      b.buckets.map(
        (bucket) =>
          `| H5: ranks ${String(bucket.from)} to ${String(bucket.to)} | ${b.exit} | ${est(bucket.estimate)} |`,
      ),
    ),
    ...d.shorts.map((s) => `| Shorts, range low | ${s.exit} | ${est(s.estimate)} |`),
    "",
  );
  if (d.costs.mismatch !== null) {
    lines.push(
      `Cost figures withheld: pricing again did not reproduce a recorded fill (${d.costs.mismatch}).`,
      "",
    );
  } else {
    lines.push(
      `Cost sensitivity, every slippage allowance scaled, the same ${n(d.costs.checked)} trades (each fill priced again reproduced its record):`,
      "",
      `| Scale | ${d.costs.sensitivity.map((s) => `Exit ${s.exit}`).join(" | ")} |`,
      `|---|${d.costs.sensitivity.map(() => "---|").join("")}`,
      ...(d.costs.sensitivity[0]?.rows ?? []).map(
        (row, i) =>
          `| ${String(row.scale)}x | ${d.costs.sensitivity.map((s) => est(s.rows[i]?.estimate ?? row.estimate)).join(" | ")} |`,
      ),
      "",
      ...d.costs.breakEven.map((b) =>
        b.stopEntryBps === null
          ? `Break-even stop-entry allowance, exit ${b.exit}: none, net mean R is not positive even with a free stop entry.`
          : `Break-even stop-entry allowance, exit ${b.exit}: ${b.aboveCeiling ? "above " : ""}${b.stopEntryBps.toFixed(2)} bps, against ${(b.modeledBps ?? 0).toFixed(2)} bps modeled on average.`,
      ),
      "",
    );
  }
  const deployed = result.asDeployed;
  if (deployed !== null) {
    const m = deployed.metrics;
    lines.push(
      "As deployed, the frozen configuration through one account:",
      "",
      `Run ${deployed.runId}: ${n(m.trades)} trades of ${n(deployed.signals)} signals, ${n(deployed.skipped)} turned away by sizing or the risk rules. Net ${m.totalDollars.toFixed(2)} dollars, max drawdown ${m.equity.maxDrawdownDollars.toFixed(2)} dollars (${((m.equity.maxDrawdownPct ?? 0) * 100).toFixed(1)}%), expectancy ${r(m.expectancyR?.mean)}.`,
      "",
    );
  }
  const block = addendumBlock(report);
  lines.push(
    "## Next",
    "",
    block === null
      ? "No exit passed. Section 10: the project stops. Nothing is frozen and the holdout does not run."
      : "Commit a dated addendum to Docs/Pre-Registration.md with the in-sample verdict, the numbers above, and this block. Then pnpm backtest l2 holdout runs the holdout, once.",
    "",
    ...(block === null ? [] : [block, ""]),
  );
  return lines.join("\n");
}

export function renderHoldoutReport(report: HoldoutReport): string {
  const lines = [
    "# L.2 holdout verdict",
    "",
    `Run ${report.runId} on commit ${report.commit?.slice(0, 8) ?? "none"}.`,
    "",
    ...preconditionTable(report.preconditions),
  ];
  if (report.result === null) {
    return [...lines, "No verdict: a precondition failed. Nothing this run measured is reported.", ""].join(
      "\n",
    );
  }
  const v = report.result.verdict;
  return [
    ...lines,
    `## Outcome: ${report.result.outcome}`,
    "",
    "| Gate | | Detail |",
    "|---|---|---|",
    `| Positive | ${mark(v.gates.positive.passed)} | ${v.gates.positive.detail} |`,
    `| Not worse | ${mark(v.gates.notWorse.passed)} | ${v.gates.notWorse.detail} |`,
    "",
    report.result.outcome === "EDGE"
      ? "Section 6: EDGE. The project proceeds to paper (M) and live-small (N)."
      : "Section 6: NO EDGE. Section 10: the project stops.",
    "",
  ].join("\n");
}
