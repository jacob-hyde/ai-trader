/**
 * Compares two runs (L.5): what they ran on, and where their configurations and results differ.
 *
 * Both are flattened to paths ("universe.topN", "outcomes.byVariant.A long.meanNetR") and compared value
 * by value, so a difference names exactly the field that moved. Lists of variants and years are keyed by
 * what they describe, not by position, so a variant added to one run does not shift every row after it.
 * R values print as R, everything else as stored. A long list (the ETF exclusions) is compared as a set
 * and prints as one line of what was added and removed.
 */

import { canonical } from "./config.js";
import type { RunRow } from "./store.js";

type Flat = Map<string, unknown>;

/** Lists longer than this are compared as sets. */
const LONG_LIST = 20;

/** A long list, held as its members. */
class Members {
  constructor(readonly items: ReadonlySet<string>) {}
}

/** The key an element of a list is compared by: its variant, year, or id, else its position. */
function keyOf(item: unknown, index: number): string {
  if (item !== null && typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record["variant"] === "string" && typeof record["direction"] === "string") {
      return `${record["variant"]} ${record["direction"]}`;
    }
    for (const field of ["year", "id", "symbol"]) {
      if (typeof record[field] === "string" || typeof record[field] === "number") {
        return String(record[field]);
      }
    }
  }
  return String(index);
}

function flatten(value: unknown, path: string, out: Flat): Flat {
  if (Array.isArray(value) && value.length > LONG_LIST) {
    out.set(path, new Members(new Set(value.map((item) => canonical(item)))));
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(path, "[]");
    }
    value.forEach((item, i) => flatten(item, `${path}.${keyOf(item, i)}`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      flatten(inner, path === "" ? key : `${path}.${key}`, out);
    }
  } else {
    out.set(path, value);
  }
  return out;
}

/** R is stored as basis points of R, under names ending in R. */
function show(path: string, value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  if (typeof value === "number" && /R$/.test(path)) {
    return `${value >= 0 ? "+" : ""}${(value / 10_000).toFixed(4)}R`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function changes(a: unknown, b: unknown, skip: (path: string) => boolean = () => false): string[] {
  const left = flatten(a, "", new Map());
  const right = flatten(b, "", new Map());
  const paths = [...new Set([...left.keys(), ...right.keys()])].filter((p) => !skip(p)).sort();
  return paths.flatMap((path) => {
    const x = left.get(path);
    const y = right.get(path);
    if (x instanceof Members || y instanceof Members) {
      const before = x instanceof Members ? x.items : new Set<string>();
      const after = y instanceof Members ? y.items : new Set<string>();
      const added = [...after].filter((item) => !before.has(item));
      const removed = [...before].filter((item) => !after.has(item));
      if (added.length === 0 && removed.length === 0) {
        return [];
      }
      const some = (items: string[]) => `${items.slice(0, 3).join(", ")}${items.length > 3 ? ", ..." : ""}`;
      return [
        `  ${path}: ${String(before.size)} -> ${String(after.size)} entries` +
          `${added.length > 0 ? `, ${String(added.length)} added (${some(added)})` : ""}` +
          `${removed.length > 0 ? `, ${String(removed.length)} removed (${some(removed)})` : ""}`,
      ];
    }
    if (x === y) {
      return [];
    }
    const change = typeof x === "number" && typeof y === "number" ? y - x : null;
    const delta =
      change === null ? "" : ` (${/R$/.test(path) || change < 0 ? "" : "+"}${show(path, change)})`;
    return [`  ${path}: ${show(path, x)} -> ${show(path, y)}${delta}`];
  });
}

const short = (value: string | null | undefined, length = 8) =>
  value == null ? "none" : value.slice(0, length);

function same(label: string, a: string, b: string): string {
  return a === b ? `${label}: same (${a})` : `${label}: ${a} -> ${b}`;
}

/** Lines that say what differs between run a and run b. */
export function diffRuns(a: RunRow, b: RunRow): string[] {
  const commit = (row: RunRow) => `${short(row.gitCommit)}${row.gitDirty === true ? "+dirty" : ""}`;
  const registration = (row: RunRow) =>
    row.registrationVersion === null
      ? "none"
      : `v${String(row.registrationVersion)} ${short(row.registrationSha256)}`;
  const config = changes(a.config, b.config, (path) => path === "name");
  const header = [
    `a: ${a.id} ${a.name} (${a.status})`,
    `b: ${b.id} ${b.name} (${b.status})`,
    same("commit", commit(a), commit(b)),
    same("data snapshot", short(a.dataSnapshot?.id, 16), short(b.dataSnapshot?.id, 16)),
    same("registration", registration(a), registration(b)),
    config.length === 0 ? "config: identical" : `config: ${String(config.length)} differences`,
    ...config,
  ];
  if (a.summary === null || b.summary === null) {
    const missing = a.summary === null ? a : b;
    return [...header, `results: ${missing === a ? "a" : "b"} has none (${missing.status})`];
  }
  // Timing is not a result: it differs on every run.
  const results = changes(a.summary, b.summary, (path) => path === "elapsedMs");
  const seconds = (row: RunRow) => `${((row.summary?.elapsedMs ?? 0) / 1_000).toFixed(1)} s`;
  return [
    ...header,
    results.length === 0 ? "results: identical" : `results: ${String(results.length)} differences`,
    ...results,
    `time: ${seconds(a)} -> ${seconds(b)}`,
  ];
}
