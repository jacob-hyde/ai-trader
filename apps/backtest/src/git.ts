/**
 * The commit the code is running from, and whether tracked files differ from it.
 *
 * Untracked files are not counted. Tracked code cannot reach a new file without changing itself, so an
 * untracked file cannot change what runs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitState } from "./guard.js";
import { REPO_ROOT } from "./registration.js";

const run = promisify(execFile);

/** Null commit when this is not a git checkout, or git is missing. */
export async function readGit(root = REPO_ROOT): Promise<GitState> {
  try {
    const [head, status] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd: root }),
      run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root }),
    ]);
    return { commit: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
  } catch {
    return { commit: null, dirty: false };
  }
}
