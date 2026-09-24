/**
 * What a run may touch.
 *
 * The holdout (Pre-Registration section 4) runs once, on a configuration frozen from the in-sample
 * result and committed before it runs. So any run that reaches a holdout session is refused unless:
 *
 * - the registration carries a frozen configuration, and the run is exactly it (only the name may
 *   differ, since a name changes nothing a run does);
 * - the working tree is clean at a known commit, so the code and the registration that ran are both
 *   what is in git, and the run row can name that commit.
 *
 * A blind run is refused there too. Blind keeps outcomes out of sight, but the holdout must not even be
 * replayed before the configuration is frozen.
 *
 * Nothing here stops a second holdout run on the same frozen configuration. A replay is deterministic,
 * so a rerun on the same commit repeats the answer, and a rerun after a bug fix is what section 10 asks
 * for. Every run is recorded with its commit, so a rerun is never silent.
 */

import { type RunConfig, canonical } from "./config.js";
import type { Registration } from "./registration.js";

export interface GitState {
  /** Null when the code is not in a git checkout. */
  readonly commit: string | null;
  /** Uncommitted changes to tracked files. */
  readonly dirty: boolean;
}

export class RunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefused";
  }
}

/** Throws RunRefused when the run may not go ahead as configured. */
export function checkRunAllowed(config: RunConfig, registration: Registration, git: GitState): void {
  const { holdout } = registration.thresholds.samples;
  if (config.to < holdout.from) {
    return;
  }
  const where = `sessions from ${holdout.from} are the holdout (Pre-Registration section 4)`;
  if (registration.frozen === null) {
    throw new RunRefused(
      `${where}. They run only on a frozen configuration committed to Docs/Pre-Registration.md, and there is none yet.`,
    );
  }
  if (git.commit === null || git.dirty) {
    throw new RunRefused(
      `${where}. They run only from a clean checkout, so the run names the commit it ran.`,
    );
  }
  const { name: _name, ...asked } = config;
  const { name: _frozenName, ...frozen } = registration.frozen;
  if (canonical(asked) !== canonical(frozen)) {
    throw new RunRefused(`${where}. This run is not the frozen configuration.`);
  }
}
