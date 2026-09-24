/**
 * Study 2.1's signal-time data (Docs/Pre-Registration-Round-2.md, section 5): each session's eligible
 * names, their last pre-market price by 09:25, and the news published overnight about the ones that
 * gapped. Nothing here reads a price after 09:25 New York.
 *
 * The screen is the study universe's (universe.ts) on section 5's rules: prior close $10 to $100, mean
 * daily volume above 1,000,000 over the prior 14 sessions, those 14 inside the last 20, the ETF and ETN
 * list excluded. The pre-market price is the close of the last SIP 5-minute bar that ended by 09:25,
 * so it is the last trade the market had printed by then. The overnight window runs from the prior
 * trading session's close to 09:25.
 *
 * Every load resumes: a session whose pre-market prices are in, or a symbol-session whose window was
 * read, is not asked again.
 */

import type { AlpacaBar, AlpacaClient } from "@trader/adapters/alpaca";
import type { Fixed, SessionDate } from "@trader/contracts";
import { fixed, fromNumber, ratio } from "@trader/core";
import type pg from "pg";
import type { Registration } from "../registration.js";
import { type EligibleName, type StudySource, StudyUniverse, type UniverseRules } from "../universe.js";

/** Section 5's screen, with the store's corrupted symbol-sessions left out as ORB's Amendment 3 finds them. */
export function gapFadeRules(registration: Registration): UniverseRules {
  const exclusions = registration.etfExclusions ?? [];
  const badTicks = registration.thresholds.samples.badTicks;
  return {
    priceMin: fromNumber(10),
    priceMax: fromNumber(100),
    minAverageVolume: 1_000_000,
    minDailyAtr: fixed(0),
    lookbackSessions: 14,
    lookbackWindowSessions: 20,
    openingRangeMinutes: 5,
    minOpeningRvol: ratio(0),
    topN: 20,
    excludeSymbols: new Map(exclusions.map(({ symbol, from }) => [symbol, from])),
    badTicks: {
      maxExcursion: ratio(Math.round(badTicks.maxExcursion * 10_000)),
      maxExcursionRanges: badTicks.maxExcursionRanges,
      rangeBars: badTicks.rangeBars,
    },
    maxCutsPerSession: badTicks.maxCutsPerSession,
  };
}

export interface MarketSession {
  readonly session: SessionDate;
  readonly openAt: number;
  readonly closeAt: number;
}

/** Every market session through `to`, oldest first, from the store's calendar. */
export async function marketSessions(pool: pg.Pool, to: SessionDate): Promise<MarketSession[]> {
  const result = await pool.query<{ session: string; open_ms: string; close_ms: string }>(
    `SELECT session::text AS session, (extract(epoch FROM open_at) * 1000)::bigint AS open_ms,
       (extract(epoch FROM close_at) * 1000)::bigint AS close_ms
     FROM market_sessions WHERE session <= $1 ORDER BY session`,
    [to],
  );
  return result.rows.map((row) => ({
    session: row.session,
    openAt: Number(row.open_ms),
    closeAt: Number(row.close_ms),
  }));
}

export interface Premarket {
  readonly price: Fixed;
  readonly volume: number;
  /** When the bar holding the last trade closed. */
  readonly asOf: number;
}

const FIVE_MINUTES = 5 * 60_000;

/** The last trade by the cutoff and the volume before it, from 5-minute bars in time order. */
export function lastPremarket(bars: readonly AlpacaBar[], cutoff: number): Premarket | null {
  let last: AlpacaBar | null = null;
  let volume = 0;
  for (const bar of bars) {
    const closes = Date.parse(bar.t) + FIVE_MINUTES;
    if (closes > cutoff) {
      break;
    }
    last = bar;
    volume += bar.v;
  }
  return last === null
    ? null
    : { price: fromNumber(last.c), volume, asOf: Date.parse(last.t) + FIVE_MINUTES };
}

/** The gap to the last pre-market trade, as a fraction of the prior close. */
export function gapOf(priorClose: Fixed, premarket: Fixed): number {
  return premarket / priorClose - 1;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Pre-market prices for a session's eligible names, once. Returns how many had a pre-market trade. */
export async function loadPremarket(
  alpaca: AlpacaClient,
  pool: pg.Pool,
  session: MarketSession,
  names: readonly EligibleName[],
): Promise<number | null> {
  const done = await pool.query("SELECT 1 FROM premarket_loads WHERE session = $1", [session.session]);
  if (done.rowCount !== 0) {
    return null;
  }
  const cutoff = session.openAt - FIVE_MINUTES;
  const bySymbol = new Map<string, AlpacaBar[]>();
  const symbols = names.map((name) => name.symbol);
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 200) {
    chunks.push(symbols.slice(i, i + 200));
  }
  // The chunks hold different symbols, so they can be read at once; the client keeps to the rate limit.
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const read: Array<Readonly<Record<string, readonly AlpacaBar[]>>> = [];
      for await (const page of alpaca.data.iterateBars({
        symbols: chunk,
        timeframe: "5Min",
        start: iso(session.openAt - 330 * 60_000),
        end: iso(cutoff - 1),
        limit: 10_000,
        adjustment: "raw",
        feed: "sip",
        asof: "-",
      })) {
        read.push(page.items);
      }
      return read;
    }),
  );
  for (const items of pages.flat()) {
    for (const [symbol, bars] of Object.entries(items)) {
      (bySymbol.get(symbol) ?? bySymbol.set(symbol, []).get(symbol))?.push(...bars);
    }
  }
  const rows = [...bySymbol].flatMap(([symbol, bars]) => {
    const last = lastPremarket(bars, cutoff);
    return last === null ? [] : [[symbol, session.session, last.price, last.volume, iso(last.asOf)]];
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        "INSERT INTO premarket_last (symbol, session, price, volume, as_of) VALUES ($1, $2, $3, $4, $5)",
        row,
      );
    }
    await client.query("INSERT INTO premarket_loads (session, symbols) VALUES ($1, $2)", [
      session.session,
      names.length,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return rows.length;
}

/** Reads the overnight news for symbols whose window has not been read yet. */
export async function loadNews(
  alpaca: AlpacaClient,
  pool: pg.Pool,
  session: SessionDate,
  symbols: readonly string[],
  from: number,
  to: number,
): Promise<void> {
  const read = await pool.query<{ symbol: string }>(
    "SELECT symbol FROM news_windows WHERE session = $1 AND symbol = ANY($2)",
    [session, symbols],
  );
  const known = new Set(read.rows.map((row) => row.symbol));
  const wanted = symbols.filter((symbol) => !known.has(symbol));
  for (let i = 0; i < wanted.length; i += 50) {
    const batch = wanted.slice(i, i + 50);
    for await (const page of alpaca.data.iterateNews({
      symbols: batch,
      start: iso(from),
      end: iso(to),
      limit: 50,
      includeContent: false,
    })) {
      for (const article of page.items) {
        await pool.query(
          `INSERT INTO news_articles (id, created_at, updated_at, headline, summary, source, symbols)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
          [
            article.id,
            article.created_at,
            article.updated_at,
            article.headline,
            article.summary,
            article.source,
            article.symbols,
          ],
        );
      }
    }
    for (const symbol of batch) {
      await pool.query(
        "INSERT INTO news_windows (symbol, session, window_from, window_to) VALUES ($1, $2, $3, $4)",
        [symbol, session, iso(from), iso(to)],
      );
    }
  }
}

export interface Gapper extends EligibleName {
  readonly session: SessionDate;
  readonly premarket: Premarket;
  readonly gap: number;
  /** Articles naming the symbol published in the overnight window. */
  readonly news: number;
}

/** Articles naming each symbol published in [from, to]. */
export async function newsCounts(
  pool: pg.Pool,
  symbols: readonly string[],
  from: number,
  to: number,
): Promise<Map<string, number>> {
  const result = await pool.query<{ symbol: string; n: string }>(
    `SELECT s.symbol, count(a.id) AS n
     FROM unnest($1::text[]) AS s(symbol)
     LEFT JOIN news_articles a ON s.symbol = ANY(a.symbols) AND a.created_at BETWEEN $2 AND $3
     GROUP BY s.symbol`,
    [symbols, iso(from), iso(to)],
  );
  return new Map(result.rows.map((row) => [row.symbol, Number(row.n)]));
}

/**
 * Walks the sessions from `from` to `to`, loading each one's pre-market prices and the overnight news of
 * every name that gapped by at least `newsGap` either way. `onSession` hears each session's gappers.
 */
export async function loadSignals(options: {
  readonly alpaca: AlpacaClient;
  readonly pool: pg.Pool;
  readonly study: StudySource;
  readonly registration: Registration;
  readonly from: SessionDate;
  readonly to: SessionDate;
  readonly newsGap: number;
  readonly onSession?: (session: SessionDate, eligible: number, gappers: readonly Gapper[]) => void;
}): Promise<void> {
  const { alpaca, pool, registration } = options;
  const excluded = new Set(registration.thresholds.samples.excludedSessions);
  const market = await marketSessions(pool, options.to);
  const calendar = market.filter((s) => !excluded.has(s.session));
  const universe = new StudyUniverse(
    options.study,
    gapFadeRules(registration),
    calendar.map((s) => s.session),
    options.from,
  );
  const index = new Map(market.map((s, i) => [s.session, i]));
  for (const session of calendar) {
    if (session.session < options.from) {
      continue;
    }
    const plan = await universe.plan(session.session);
    // Sessions with no lookback yet have nobody eligible.
    if (plan.eligibleNames.length === 0) {
      options.onSession?.(session.session, 0, []);
      continue;
    }
    await loadPremarket(alpaca, pool, session, plan.eligibleNames);
    const prices = await pool.query<{ symbol: string; price: string; volume: string; as_of: Date }>(
      "SELECT symbol, price, volume, as_of FROM premarket_last WHERE session = $1",
      [session.session],
    );
    const bySymbol = new Map(prices.rows.map((row) => [row.symbol, row]));
    const moved = plan.eligibleNames.flatMap((name) => {
      const row = bySymbol.get(name.symbol);
      if (row === undefined) {
        return [];
      }
      const premarket = {
        price: Number(row.price) as Fixed,
        volume: Number(row.volume),
        asOf: row.as_of.getTime(),
      };
      const gap = gapOf(name.priorClose, premarket.price);
      return Math.abs(gap) >= options.newsGap ? [{ ...name, session: session.session, premarket, gap }] : [];
    });
    const prior = market[(index.get(session.session) ?? 0) - 1];
    let counts = new Map<string, number>();
    if (moved.length > 0 && prior !== undefined) {
      const symbols = moved.map((g) => g.symbol);
      const from = prior.closeAt;
      const to = session.openAt - FIVE_MINUTES;
      await loadNews(alpaca, pool, session.session, symbols, from, to);
      counts = await newsCounts(pool, symbols, from, to);
    }
    const gappers = moved.map((g) => ({ ...g, news: counts.get(g.symbol) ?? 0 }));
    options.onSession?.(session.session, plan.eligibleNames.length, gappers);
  }
}
