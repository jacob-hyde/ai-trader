/**
 * The data snapshot's id (L.5): a short hash of what the store says it holds.
 */

import { createHash } from "node:crypto";
import { canonical } from "./config.js";
import type { DataSnapshot } from "./universe.js";

export function snapshotOf(facts: Readonly<Record<string, unknown>>): DataSnapshot {
  return { id: createHash("sha256").update(canonical(facts)).digest("hex").slice(0, 16), facts };
}
