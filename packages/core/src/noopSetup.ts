/**
 * A setup that never trades. Exists so the framework and the engine tests have something to host that
 * is not ORB.
 *
 * Never applies and never signals. stop, target, and invalidation still answer within the contract, so
 * a test can hand it a hand-built signal.
 */

import { z } from "zod";
import { add, sub, tickSize } from "./money.js";
import type { SetupDefinition } from "./setup.js";

const noopParams = z.object({});

export const noopSetupDefinition: SetupDefinition<typeof noopParams> = {
  id: "noop",
  version: "1.0.0",
  directions: ["long", "short"],
  warmup: { dailyBars: 0, sessions: 0, sessionBars: 0 },
  paramsSchema: noopParams,
  create: () => ({
    evaluateContext: () => ({ applies: false, reasons: ["NOOP_NEVER_APPLIES"] }),
    detectTrigger: () => null,
    // One tick on the risk side of entry, the tightest stop the contract allows.
    stop: (signal) =>
      signal.direction === "long"
        ? sub(signal.entry, tickSize(signal.entry))
        : add(signal.entry, tickSize(signal.entry)),
    target: () => null,
    invalidation: () => true,
  }),
};
