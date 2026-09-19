import { CORE_VERSION } from "@trader/core";
import { AlpacaClient } from "./alpaca/client.js";
import { loadConfig } from "./config.js";

// Boot smoke test: validate env, announce the mode, prove the broker connection. Trading loops land later.
const cfg = loadConfig();

console.log(`[engine] mode=${cfg.TRADING_MODE.toUpperCase()} core=${CORE_VERSION}`);
if (cfg.TRADING_MODE === "live") {
  console.log("[engine] *** LIVE TRADING MODE. REAL MONEY. ***");
}

const alpaca = new AlpacaClient(cfg);
const [clock, account] = await Promise.all([alpaca.getClock(), alpaca.getAccount()]);

console.log(
  `[alpaca] market=${clock.is_open ? "OPEN" : "CLOSED"} next_open=${clock.next_open} next_close=${clock.next_close}`,
);
console.log(
  `[alpaca] account=${account.account_number} status=${account.status} equity=${account.equity} ` +
    `cash=${account.cash} buying_power=${account.buying_power} multiplier=${account.multiplier}x ` +
    `pdt=${account.pattern_day_trader ?? "n/a"} blocked=${account.trading_blocked || account.account_blocked}`,
);
