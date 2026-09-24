import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TimescaleStudySource } from "./timescale.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const engineUrl = process.env["DATABASE_URL"] ?? "";

// Tickers no exchange uses, so the test shares a database with real loads safely. Never compressed.
const LOADED = "ZZTSLOAD";
const UNLOADED = "ZZTSNONE";
const DAYS = ["2023-03-06", "2023-03-07"] as const;
const openOf = (day: string) => Date.parse(`${day}T14:30:00Z`);

describe.skipIf(engineUrl === "")("the bar store as the study's source", () => {
  let pool: pg.Pool;

  async function clean(): Promise<void> {
    const symbols = [LOADED, UNLOADED];
    await pool.query(
      "DELETE FROM bars_1m WHERE symbol = ANY($1) AND ts >= '2023-03-01' AND ts < '2023-04-01'",
      [symbols],
    );
    await pool.query(
      "DELETE FROM bars_1d WHERE symbol = ANY($1) AND session BETWEEN '2023-03-01' AND '2023-03-31'",
      [symbols],
    );
    await pool.query("DELETE FROM bar_load_checkpoints WHERE symbol = ANY($1)", [symbols]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: engineUrl, max: 2 });
    await clean();
    for (const symbol of [LOADED, UNLOADED]) {
      for (const [d, day] of DAYS.entries()) {
        await pool.query(
          `INSERT INTO bars_1d (symbol, session, open, high, low, close, volume, trades, vwap, split_factor)
           VALUES ($1, $2, 200000, 205000, 195000, 201000, 2000000, 100, NULL, $3)`,
          [symbol, day, d === 0 ? 2 : null],
        );
        // Minutes 0 to 6, trading 100, 101, ... shares: the first five sum to 510.
        for (let minute = 0; minute < 7; minute += 1) {
          await pool.query(
            `INSERT INTO bars_1m (symbol, ts, session, minute, open, high, low, close, volume, trades, vwap)
             VALUES ($1, $2, $3, $4, 200000, 200000, 200000, 200000, $5, 1, NULL)`,
            [
              symbol,
              new Date(openOf(day) + minute * 60_000).toISOString(),
              day,
              minute,
              100 + minute + d * 10,
            ],
          );
        }
      }
    }
    await pool.query(
      `INSERT INTO bar_load_checkpoints (timeframe, symbol, month, status, rows, sessions)
       VALUES ('1Min', $1, '2023-03-01', 'complete', 14, 2), ('1Min', $2, '2023-03-01', 'partial', 14, 2)`,
      [LOADED, UNLOADED],
    );
  });

  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("reads a month of daily bars, opening volumes, and the loaded months", async () => {
    const source = new TimescaleStudySource(pool);
    const ours = <T extends { symbol: string }>(rows: readonly T[]) =>
      rows.filter((row) => row.symbol === LOADED || row.symbol === UNLOADED);

    const daily = ours(await source.dailyBars("2023-03"));
    expect(daily.map((b) => [b.session, b.symbol, b.close, b.volume, b.splitFactor])).toEqual([
      ["2023-03-06", LOADED, 201_000, 2_000_000, 2],
      ["2023-03-06", UNLOADED, 201_000, 2_000_000, 2],
      ["2023-03-07", LOADED, 201_000, 2_000_000, null],
      ["2023-03-07", UNLOADED, 201_000, 2_000_000, null],
    ]);
    expect(ours(await source.dailyBars("2023-04"))).toEqual([]);

    // Only minutes 0 to 4: 100+101+102+103+104 on the first day, ten more a minute on the second.
    const opening = ours(await source.openingVolumes("2023-03", 5)).sort((a, b) =>
      `${a.session}${a.symbol}` < `${b.session}${b.symbol}` ? -1 : 1,
    );
    expect(opening).toEqual([
      { symbol: LOADED, session: "2023-03-06", volume: 510 },
      { symbol: UNLOADED, session: "2023-03-06", volume: 510 },
      { symbol: LOADED, session: "2023-03-07", volume: 560 },
      { symbol: UNLOADED, session: "2023-03-07", volume: 560 },
    ]);

    const months = await source.minuteMonths();
    expect(months.get(LOADED)).toEqual(new Set(["2023-03"]));
    // A partial month is not loaded.
    expect(months.has(UNLOADED)).toBe(false);
  });
});
