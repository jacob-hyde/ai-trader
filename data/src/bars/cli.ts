/**
 * The historical bar load (H.7).
 *
 *   pnpm bars calendar                 sessions 2016 through next year, from Alpaca's calendar
 *   pnpm bars symbols [--file f]       the ticker list: asset list, corporate actions, a file
 *   pnpm bars daily                    daily bars for every ticker on the list
 *   pnpm bars universe                 which symbol-months pass the liquidity screen (prints, loads nothing)
 *   pnpm bars minute --universe        minute bars for those symbol-months
 *   pnpm bars minute --symbols A,B     or for named symbols, every month in the range
 *   pnpm bars minute --units f         or exactly the symbol-months a file lists, one "SYMBOL YYYY-MM" a line
 *   pnpm bars suspects                 symbol-sessions with a wick 9% past its body, for the bad-tick filter
 *   pnpm bars verify                   coverage against the calendar, gaps listed
 *   pnpm bars compress                 compress now rather than waiting for the policy (table owner)
 *   pnpm bars analyze                  refresh the planner's statistics on the load's tables (table owner)
 *   pnpm bars status                   sizes, checkpoints, and timed backtest reads
 *   pnpm bars all                      calendar, symbols, daily, minute --universe, suspects, verify, compress
 *
 * Every load resumes: run it again and it fetches only the symbol-months without a complete checkpoint.
 * A file path is taken relative to where pnpm was run.
 * --from and --to take a month or a date (default 2016-01 through today). Loads connect as the engine
 * role (DATABASE_URL). The table owner (MIGRATION_DATABASE_URL) is needed to compress, by the compress
 * command and by the minute load as each month finishes, and to analyze, which every load does when it
 * ends. Without the owner both are left to the background jobs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AlpacaClient, type Logger } from "@trader/adapters/alpaca";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { BarLoader, type Unit, type UnitGrid } from "./loader.js";
import {
  analyzeNow,
  checkpointSummary,
  compressNow,
  compressionStats,
  timeBacktestReads,
} from "./maintenance.js";
import { minuteMonths, scanWideWicks } from "./badTicks.js";
import { alpacaSource } from "./source.js";
import { BarStore } from "./store.js";
import { fromAssets, fromCorporateActions, fromFile } from "./symbols.js";
import { monthOf, monthsBetween, newYorkDate, nextMonth, sessionTimes } from "./time.js";
import { PUBLISHED_SCREEN, eligibleSessions, monthsToLoad } from "./universe.js";
import { formatReport, verify } from "./verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set (see .env.example)`);
  }
  return value;
}

function flags(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        parsed.set(arg.slice(2), "true");
      } else {
        parsed.set(arg.slice(2), next);
        i += 1;
      }
    }
  }
  return parsed;
}

const log = (line: string): void => console.log(`[bars] ${line}`);

/** pnpm runs this from data/, so a path the caller typed is relative to where they ran pnpm. */
function fromCaller(file: string): string {
  return path.resolve(process.env["INIT_CWD"] ?? process.cwd(), file);
}

/** "SYMBOL YYYY-MM" a line, or "SYMBOL|YYYY-MM". Blank lines and anything after a # are ignored. */
function unitsFromFile(file: string): Unit[] {
  return readFileSync(fromCaller(file), "utf8")
    .split("\n")
    .map((line) => (line.split("#")[0] ?? "").trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [symbol = "", month = ""] = line.split(/[\s|]+/);
      return { symbol: symbol.toUpperCase(), month: monthOf(month) };
    });
}

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, fields) => console.warn(`[alpaca] ${message}`, fields ?? ""),
  error: (message, fields) => console.error(`[alpaca] ${message}`, fields ?? ""),
};

const [command = "status", ...rest] = process.argv.slice(2);
const options = flags(rest);
const today = newYorkDate(new Date());
const from = options.get("from") ?? "2016-01-01";
const to = options.get("to") ?? today;
const fromDate = /^\d{4}-\d{2}$/.test(from) ? `${from}-01` : from;
const toDate = /^\d{4}-\d{2}$/.test(to)
  ? new Date(Date.parse(`${nextMonth(`${to}-01`)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  : to;
const named =
  options
    .get("symbols")
    ?.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) ?? null;

const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 8 });
const store = new BarStore(pool);
let client = null as AlpacaClient | null;
function alpaca(): AlpacaClient {
  client ??= new AlpacaClient({
    keyId: env("ALPACA_KEY_ID"),
    secretKey: env("ALPACA_SECRET_KEY"),
    tradingUrl: env("ALPACA_BASE_URL"),
    dataUrl: process.env["ALPACA_DATA_URL"] ?? "https://data.alpaca.markets",
    dataRequestsPerMinute: Number(process.env["ALPACA_DATA_RATE_LIMIT"] ?? 200),
    logger: quiet,
    // Pages of 10,000 minute bars take a while to arrive.
    timeoutMs: 60_000,
  });
  return client;
}

async function calendar(): Promise<void> {
  const end = `${String(Number(today.slice(0, 4)) + 1)}-12-31`;
  const days = await alpaca().trading.getCalendar({ start: "2016-01-01", end });
  await store.saveSessions(days.map(sessionTimes));
  log(`calendar: ${String(days.length)} sessions, 2016-01-01..${end}`);
}

async function symbols(): Promise<void> {
  const source = alpacaSource(alpaca());
  const assets = await source.assets();
  await store.saveAssetSnapshot(new Date(), assets);
  let added = await store.addSymbols(fromAssets(assets));
  log(`symbols: asset list has ${String(assets.length)} US equities, ${String(added)} new tickers`);
  for (let year = Number(fromDate.slice(0, 4)); year <= Number(today.slice(0, 4)); year += 1) {
    let found = 0;
    for await (const actions of source.corporateActions(`${String(year)}-01-01`, `${String(year)}-12-31`)) {
      const entries = fromCorporateActions(actions);
      found += entries.length;
      added = await store.addSymbols(entries);
    }
    log(`symbols: ${String(year)} corporate actions named ${String(found)} tickers`);
  }
  const file = options.get("file");
  if (file !== undefined) {
    added = await store.addSymbols(fromFile(readFileSync(fromCaller(file), "utf8"), path.basename(file)));
    log(`symbols: ${String(added)} new from ${file}`);
  }
  log(`symbols: ${String((await store.allSymbols()).length)} tickers on the list`);
}

function unitsFor(list: readonly string[]): UnitGrid {
  return { symbols: list, months: monthsBetween(fromDate, toDate) };
}

async function daily(): Promise<boolean> {
  const list = named ?? (await store.allSymbols());
  const result = await new BarLoader(alpacaSource(alpaca()), store).load({
    timeframe: "1Day",
    units: unitsFor(list),
    concurrency: Number(options.get("concurrency") ?? 4),
    log,
  });
  await store.refreshSymbolRanges();
  log(
    `daily: ${String(result.rows)} rows, dropped ${JSON.stringify(result.dropped)}, ${String(result.failedJobs)} failed jobs`,
  );
  return result.failedJobs === 0;
}

async function suspects(): Promise<void> {
  const months = await minuteMonths(pool, fromDate, toDate);
  const found = await scanWideWicks(pool, months, log);
  log(`suspects: ${String(found)} symbol-sessions over ${String(months.length)} months`);
}

async function universe(): Promise<Unit[]> {
  const list = named ?? (await store.symbolsWithDailyBars(fromDate, toDate));
  // Enough history before the range for the lookback to be warm on its first session.
  const historyFrom = new Date(Date.parse(`${fromDate}T00:00:00Z`) - 60 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const first = monthOf(fromDate);
  const last = monthOf(toDate);
  const units: Unit[] = [];
  let eligibleDays = 0;
  let selected = 0;
  for (const [index, symbol] of list.entries()) {
    if (index > 0 && index % 5_000 === 0) {
      log(`universe: ${String(index)} of ${String(list.length)} symbols screened`);
    }
    const eligible = eligibleSessions(
      await store.dailyBars(symbol, historyFrom, toDate),
      PUBLISHED_SCREEN,
    ).filter((session) => session >= fromDate);
    eligibleDays += eligible.length;
    const months = monthsToLoad(eligible).filter((month) => month >= first && month <= last);
    if (months.length > 0) {
      selected += 1;
    }
    units.push(...months.map((month) => ({ symbol, month })));
  }
  log(
    `universe: ${String(selected)} of ${String(list.length)} symbols pass the screen on ${String(eligibleDays)} symbol-sessions; ` +
      `${String(units.length)} symbol-months of minute bars (at most ~${((units.length * 21 * 390) / 1e6).toFixed(0)}M rows)`,
  );
  return units;
}

/**
 * Minute bars a month at a time, oldest first, compressing each finished month before the next. Loading
 * ten years and compressing afterwards would need the whole set uncompressed on disk, about seven times
 * its compressed size; this way about a month is uncompressed at once. Compressing needs the table
 * owner, so without MIGRATION_DATABASE_URL the months are left to the policy.
 */
async function minute(units: readonly Unit[] | UnitGrid): Promise<boolean> {
  const byMonth = new Map<string, string[]>();
  if ("symbols" in units) {
    for (const month of units.months) {
      byMonth.set(month, [...units.symbols]);
    }
  } else {
    for (const unit of units) {
      (byMonth.get(unit.month) ?? byMonth.set(unit.month, []).get(unit.month))?.push(unit.symbol);
    }
  }
  const ownerUrl = process.env["MIGRATION_DATABASE_URL"];
  const owner =
    ownerUrl === undefined || ownerUrl === "" ? null : new pg.Pool({ connectionString: ownerUrl, max: 1 });
  if (owner === null) {
    log("minute: MIGRATION_DATABASE_URL is not set, so compression is left to the policy");
  }
  const loader = new BarLoader(alpacaSource(alpaca()), store);
  const months = [...byMonth.keys()].sort();
  const started = Date.now();
  let rows = 0;
  let failedJobs = 0;
  const dropped = { outsideSession: 0, invalid: 0 };
  try {
    for (const [index, month] of months.entries()) {
      const result = await loader.load({
        timeframe: "1Min",
        units: (byMonth.get(month) ?? []).map((symbol) => ({ symbol, month })),
        concurrency: Number(options.get("concurrency") ?? 4),
        log,
      });
      rows += result.rows;
      failedJobs += result.failedJobs;
      dropped.outsideSession += result.dropped.outsideSession;
      dropped.invalid += result.dropped.invalid;
      if (result.aborted) {
        break;
      }
      const compressed =
        owner !== null && result.jobs > 0
          ? await compressNow(owner, { tables: ["bars_1m"], before: nextMonth(month) })
          : 0;
      const left = Math.round(
        (((Date.now() - started) / (index + 1)) * (months.length - index - 1)) / 60_000,
      );
      log(
        `minute ${month.slice(0, 7)} done (${String(index + 1)}/${String(months.length)} months, ` +
          `${String(compressed)} chunks compressed, ~${String(left)} min left)`,
      );
    }
  } finally {
    await owner?.end();
  }
  log(
    `minute: ${String(rows)} rows, dropped ${JSON.stringify(dropped)} (outsideSession is pre- and after-market), ` +
      `${String(failedJobs)} failed jobs`,
  );
  return failedJobs === 0;
}

async function report(): Promise<void> {
  for (const line of formatReport(await verify(pool, fromDate, toDate, named))) {
    log(line);
  }
}

/** Refreshes the planner's statistics after a load, when the owner is available. See analyzeNow. */
async function analyze(): Promise<void> {
  const ownerUrl = process.env["MIGRATION_DATABASE_URL"];
  if (ownerUrl === undefined || ownerUrl === "") {
    log("analyze: MIGRATION_DATABASE_URL is not set, so statistics are left to autovacuum");
    return;
  }
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    log(`analyze: ${(await analyzeNow(owner)).join(", ")}`);
  } finally {
    await owner.end();
  }
}

async function compress(): Promise<void> {
  const owner = new pg.Pool({ connectionString: env("MIGRATION_DATABASE_URL"), max: 1 });
  try {
    log(`compress: ${String(await compressNow(owner))} chunks compressed`);
  } finally {
    await owner.end();
  }
}

async function status(): Promise<void> {
  const mb = (bytes: number | null): string => (bytes === null ? "n/a" : `${(bytes / 1e6).toFixed(1)} MB`);
  for (const s of await compressionStats(pool)) {
    log(
      `${s.table}: ${String(s.compressedChunks)}/${String(s.chunks)} chunks compressed, ${mb(s.totalBytes)} on disk` +
        (s.beforeBytes === null ? "" : ` (compressed chunks ${mb(s.beforeBytes)} -> ${mb(s.afterBytes)})`),
    );
  }
  for (const c of await checkpointSummary(pool)) {
    log(
      `checkpoints ${c.timeframe} ${c.status}: ${String(c.months)} symbol-months, ${String(c.symbols)} symbols, ${String(c.rows)} rows`,
    );
  }
  for (const t of await timeBacktestReads(pool)) {
    log(`read ${t.what}: ${String(t.rows)} rows in ${String(t.ms)} ms`);
  }
}

let ok = true;
try {
  switch (command) {
    case "calendar":
      await calendar();
      await analyze();
      break;
    case "symbols":
      await symbols();
      await analyze();
      break;
    case "daily":
      ok = await daily();
      await analyze();
      break;
    case "universe":
      await universe();
      break;
    case "minute":
      if (options.has("universe")) {
        ok = await minute(await universe());
      } else if (named !== null) {
        ok = await minute(unitsFor(named));
      } else if (options.has("units")) {
        ok = await minute(unitsFromFile(options.get("units") as string));
      } else {
        throw new Error("minute needs --universe, --symbols, or --units");
      }
      await analyze();
      break;
    case "suspects":
      await suspects();
      break;
    case "verify":
      await report();
      break;
    case "compress":
      await compress();
      break;
    case "analyze":
      await analyze();
      break;
    case "status":
      await status();
      break;
    case "all":
      await calendar();
      await symbols();
      ok = (await daily()) && ok;
      ok = (await minute(await universe())) && ok;
      await suspects();
      // Before verify, which plans its queries on these statistics.
      await analyze();
      await report();
      await compress();
      await status();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
} finally {
  await client?.close();
  await pool.end();
}
process.exitCode = ok ? 0 : 1;
