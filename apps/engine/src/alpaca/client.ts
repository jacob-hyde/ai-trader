import type { Config } from "../config.js";

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  equity: string;
  buying_power: string;
  daytrading_buying_power: string;
  multiplier: string;
  // Absent on paper accounts since the PDT rule was retired; keep optional.
  pattern_day_trader?: boolean;
  trading_blocked: boolean;
  account_blocked: boolean;
}

export interface AlpacaClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

type Creds = Pick<Config, "ALPACA_KEY_ID" | "ALPACA_SECRET_KEY" | "ALPACA_BASE_URL">;

/**
 * Minimal read-only Alpaca REST client.
 *
 * Account and clock only. Order endpoints arrive with the order lifecycle work (EPIC-G) behind the
 * idempotency layer, so nothing in this file can place a trade.
 */
export class AlpacaClient {
  constructor(private readonly creds: Creds) {}

  getAccount(): Promise<AlpacaAccount> {
    return this.get<AlpacaAccount>("/v2/account");
  }

  getClock(): Promise<AlpacaClock> {
    return this.get<AlpacaClock>("/v2/clock");
  }

  private async get<T>(pathname: string): Promise<T> {
    const res = await fetch(`${this.creds.ALPACA_BASE_URL}${pathname}`, {
      headers: {
        "APCA-API-KEY-ID": this.creds.ALPACA_KEY_ID,
        "APCA-API-SECRET-KEY": this.creds.ALPACA_SECRET_KEY,
      },
    });
    if (!res.ok) {
      throw new Error(`Alpaca GET ${pathname} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
}
