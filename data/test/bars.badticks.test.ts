import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minuteMonths, scanWideWicks } from "../src/bars/badTicks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

const engineUrl = process.env["DATABASE_URL"] ?? "";

// Tickers no exchange uses. The scan rewrites the month's candidates from the bars themselves, so the
// real rows come back unchanged, with a fresh scan time.
const WIDE = "ZZTWWIDE";
const CLEAN = "ZZTWCLEAN";
const DAY = "2023-03-09";
const MONTH = "2023-03-01";
const openAt = Date.parse(`${DAY}T14:30:00Z`);

describe.skipIf(engineUrl === "")("the wide-wick scan", () => {
  let pool: pg.Pool;

  async function clean(): Promise<void> {
    await pool.query("DELETE FROM bars_1m WHERE symbol = ANY($1) AND ts >= $2 AND ts < $3", [
      [WIDE, CLEAN],
      `${DAY}T00:00:00Z`,
      `${DAY}T23:59:59Z`,
    ]);
    await pool.query("DELETE FROM bad_tick_candidates WHERE symbol = ANY($1)", [[WIDE, CLEAN]]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: engineUrl, max: 2 });
    await clean();
    // WIDE: a high 9.5% over its body, a low 10% under it, and one of 8% that stays out. CLEAN: nothing.
    const bars: Array<[string, number, number, number, number, number]> = [
      [WIDE, 0, 200_000, 219_000, 199_000, 200_000],
      [WIDE, 1, 200_000, 201_000, 180_000, 200_000],
      [WIDE, 2, 200_000, 216_000, 199_000, 200_000],
      [CLEAN, 0, 200_000, 201_000, 199_000, 200_000],
    ];
    for (const [symbol, minute, open, high, low, close] of bars) {
      await pool.query(
        `INSERT INTO bars_1m (symbol, ts, session, minute, open, high, low, close, volume, trades, vwap)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 100, 1, NULL)`,
        [symbol, new Date(openAt + minute * 60_000).toISOString(), DAY, minute, open, high, low, close],
      );
    }
  });

  afterAll(async () => {
    await clean();
    // Leave the month's real candidates exactly as the bars give them.
    await scanWideWicks(pool, [MONTH]);
    await pool.end();
  });

  it(
    "keeps each symbol-session with a wick more than 9% past its body, and stamps the month",
    { timeout: 120_000 },
    async () => {
      const before = Date.now();
      await scanWideWicks(pool, [MONTH]);
      const found = await pool.query<{ symbol: string; wide_bars: number }>(
        `SELECT symbol, wide_bars FROM bad_tick_candidates WHERE symbol = ANY($1) ORDER BY symbol`,
        [[WIDE, CLEAN]],
      );
      expect(found.rows).toEqual([{ symbol: WIDE, wide_bars: 2 }]);
      const scan = await pool.query<{ scanned_at: Date }>(
        "SELECT scanned_at FROM bad_tick_scans WHERE month = $1",
        [MONTH],
      );
      expect(scan.rows[0]?.scanned_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    },
  );

  it("lists the months that hold minute bars", async () => {
    await pool.query(
      `INSERT INTO bar_load_checkpoints (timeframe, symbol, month, status, rows, sessions)
       VALUES ('1Min', $1, $2, 'complete', 3, 1) ON CONFLICT DO NOTHING`,
      [WIDE, MONTH],
    );
    try {
      expect(await minuteMonths(pool, "2023-03-15", "2023-03-31")).toContain(MONTH);
      expect(await minuteMonths(pool, "2015-01-01", "2015-02-28")).toEqual([]);
    } finally {
      await pool.query("DELETE FROM bar_load_checkpoints WHERE symbol = $1", [WIDE]);
    }
  });
});
