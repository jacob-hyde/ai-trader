import { AlpacaClient, type Logger } from "@trader/adapters/alpaca";
import type { Config } from "./config.js";

/** Prints the client's retries, waits, and reconnects. Its fields never hold a credential. */
export const consoleLogger: Logger = {
  debug: () => undefined,
  info: (message, fields) => console.log(`[alpaca] ${message}`, fields ?? ""),
  warn: (message, fields) => console.warn(`[alpaca] ${message}`, fields ?? ""),
  error: (message, fields) => console.error(`[alpaca] ${message}`, fields ?? ""),
};

/** The engine's Alpaca client, from config. The base URL alone decides paper or live. */
export function createAlpacaClient(cfg: Config, logger: Logger = consoleLogger): AlpacaClient {
  return new AlpacaClient({
    keyId: cfg.ALPACA_KEY_ID,
    secretKey: cfg.ALPACA_SECRET_KEY,
    tradingUrl: cfg.ALPACA_BASE_URL,
    dataUrl: cfg.ALPACA_DATA_URL,
    streamUrl: cfg.ALPACA_STREAM_URL,
    feed: cfg.ALPACA_DATA_FEED,
    dataRequestsPerMinute: cfg.ALPACA_DATA_RATE_LIMIT,
    logger,
  });
}
