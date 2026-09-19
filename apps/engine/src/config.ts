import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { RUN_MODES } from "@trader/contracts";

// Loads the repo-root .env so the engine behaves the same from any cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const Env = z.object({
  TRADING_MODE: z.enum(RUN_MODES).default("paper"),
  ALPACA_KEY_ID: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_BASE_URL: z.string().url(),
  ALPACA_DATA_URL: z.string().url().default("https://data.alpaca.markets"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  NTFY_TOPIC: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

/**
 * Validates the environment and returns a typed config.
 *
 * Fails fast on a missing or malformed variable and names only the variable, never its value, so a
 * boot failure can be pasted anywhere.
 *
 * Live mode additionally requires LIVE_TRADING_ACK=I_UNDERSTAND. Stands in for the 2FA gate until the
 * web app provides one; the engine must never be able to drift into live by a single env edit.
 */
export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment: ${names}`);
  }
  if (parsed.data.TRADING_MODE === "live" && process.env["LIVE_TRADING_ACK"] !== "I_UNDERSTAND") {
    throw new Error("TRADING_MODE=live requires LIVE_TRADING_ACK=I_UNDERSTAND");
  }
  return parsed.data;
}
