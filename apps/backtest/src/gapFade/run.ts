/**
 * Runs study 2.1 in-sample and keeps it (migration 0012): the signals from the store, the prices from
 * the market's auction prints, the verdict, and a report.
 *
 * The run reads only what section 5 registers. The universe must be the one the signal data was loaded
 * on, or the run refuses; the checks that need git (a clean checkout, the round's file in its commit)
 * are the caller's, since they are about where the code runs.
 */

import type { AlpacaClient } from "@trader/adapters/alpaca";
import { basisRatio, restatePrice } from "@trader/adapters";
import type { Fixed, SessionDate } from "@trader/contracts";
import type pg from "pg";
import type { GitState } from "../guard.js";
import type { Registration } from "../registration.js";
import type { GapFadeSpec, Round2Registration } from "../round2.js";
import type { StudySource } from "../universe.js";
import { type AuctionPrint, loadAuction } from "./auction.js";
import { type Gapper, type MarketSession, loadSignals, marketSessions } from "./signals.js";
import { type GapFadeResult, type PricedTrade, judge, netMillionths, pick, underPriceTest } from "./study.js";

/** The universe the signal data was loaded on. A registered spec must match it. */
export const LOADED_UNIVERSE: GapFadeSpec["universe"] = {
  priceMin: 10,
  priceMax: 100,
  minAverageVolume: 1_000_000,
  lookbackSessions: 14,
  lookbackWindowSessions: 20,
};

/** The gap at which the loader read the overnight news: the least any spec may register. */
export const NEWS_GAP = 0.02;

export interface GapFadeRun {
  readonly id: string;
  readonly result: GapFadeResult;
  readonly trades: readonly PricedTrade[];
  readonly sessions: number;
  readonly restricted: number;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping their order. */
async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await work(items[i] as T);
      }
    }),
  );
  return out;
}

/** The names under the short-sale price test on a session, from the two sessions before it. */
async function restrictedOn(
  pool: pg.Pool,
  symbols: readonly string[],
  prior: MarketSession,
  before: MarketSession,
  drop: number,
): Promise<Set<string>> {
  const result = await pool.query<{
    symbol: string;
    session: string;
    low: string;
    close: string;
    split_factor: number | null;
  }>(
    `SELECT symbol, session::text AS session, low, close, split_factor FROM bars_1d
     WHERE symbol = ANY($1) AND session = ANY($2)`,
    [symbols, [prior.session, before.session]],
  );
  const bars = new Map(result.rows.map((row) => [`${row.symbol} ${row.session}`, row]));
  const restricted = new Set<string>();
  for (const symbol of symbols) {
    const p = bars.get(`${symbol} ${prior.session}`);
    const b = bars.get(`${symbol} ${before.session}`);
    if (p === undefined || b === undefined) {
      continue;
    }
    const closeBefore = restatePrice(Number(b.close) as Fixed, basisRatio(b.split_factor, p.split_factor));
    if (underPriceTest(Number(p.low), closeBefore, drop)) {
      restricted.add(symbol);
    }
  }
  return restricted;
}

export async function runGapFadeInSample(deps: {
  readonly alpaca: AlpacaClient;
  readonly pool: pg.Pool;
  readonly study: StudySource;
  readonly registration: Registration;
  readonly round2: Round2Registration;
  readonly spec: GapFadeSpec;
  readonly git: GitState;
  readonly onProgress?: (message: string) => void;
}): Promise<GapFadeRun> {
  const { alpaca, pool, registration, round2, spec } = deps;
  const { round } = round2;
  const say = deps.onProgress ?? (() => undefined);
  if (JSON.stringify(spec.universe) !== JSON.stringify(LOADED_UNIVERSE)) {
    throw new Error("the registered universe is not the one the signal data was loaded on");
  }
  if (spec.minGap < NEWS_GAP) {
    throw new Error(
      `the overnight news was read for gaps of ${String(NEWS_GAP)} and up, under the registered minimum`,
    );
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO study_runs (id, study, sample, git_commit, git_dirty, registration_sha256, spec)
     VALUES ($1, '2.1', 'inSample', $2, $3, $4, $5)`,
    [id, deps.git.commit, deps.git.dirty, round2.sha256, JSON.stringify(spec)],
  );

  // Signals, from the store; anything missing is read now, all of it from before 09:25.
  const bySession = new Map<SessionDate, readonly Gapper[]>();
  await loadSignals({
    alpaca,
    pool,
    study: deps.study,
    registration,
    from: registration.thresholds.samples.inSample.firstTradable,
    to: round.samples.inSample.to,
    newsGap: NEWS_GAP,
    onSession: (session, _eligible, gappers) => {
      bySession.set(session, gappers);
      if (bySession.size % 250 === 0) {
        say(`signals through ${session}`);
      }
    },
  });

  const market = await marketSessions(pool, round.samples.inSample.to);
  const at = new Map(market.map((s, i) => [s.session, i]));
  const rules = { minGap: spec.minGap, topN: spec.topN };
  const chosen: Gapper[] = [];
  const withNews: Gapper[] = [];
  const gapDowns: Gapper[] = [];
  let restrictedCount = 0;
  for (const [session, gappers] of bySession) {
    const i = at.get(session) ?? 0;
    const prior = market[i - 1];
    const before = market[i - 2];
    const ups = gappers.filter((g) => g.gap >= spec.minGap).map((g) => g.symbol);
    const restricted =
      prior === undefined || before === undefined || ups.length === 0
        ? new Set<string>()
        : await restrictedOn(pool, ups, prior, before, round.shorts.shortSaleTestDrop);
    restrictedCount += pick(gappers, { ...rules, topN: Number.POSITIVE_INFINITY }, new Set()).filter((g) =>
      restricted.has(g.symbol),
    ).length;
    chosen.push(...pick(gappers, rules, restricted));
    withNews.push(...pick(gappers, rules, restricted, "up", "news"));
    gapDowns.push(...pick(gappers, rules, new Set(), "down"));
  }
  say(`${String(chosen.length)} trades to price from the auctions`);

  const bounds = new Map(market.map((s) => [s.session, s]));
  let done = 0;
  const trades = await eachLimited(chosen, 3, async (g): Promise<PricedTrade> => {
    const session = bounds.get(g.session) as MarketSession;
    const open: AuctionPrint | null = await loadAuction(alpaca, pool, g.symbol, session, "open");
    const close: AuctionPrint | null =
      open === null ? null : await loadAuction(alpaca, pool, g.symbol, session, "close");
    done += 1;
    if (done % 250 === 0) {
      say(`priced ${String(done)} of ${String(chosen.length)}`);
    }
    return {
      symbol: g.symbol,
      session: g.session,
      gap: g.gap,
      open,
      close,
      net:
        open === null || close === null
          ? null
          : netMillionths("short", open.price, close.price, round.prices.saleFeeBps),
    };
  });

  // The diagnostics' prices: each day's own bar, as traded.
  const diag = [...withNews, ...gapDowns];
  const daily = await pool.query<{ symbol: string; session: string; open: string; close: string }>(
    `SELECT b.symbol, b.session::text AS session, b.open, b.close
     FROM bars_1d b JOIN unnest($1::text[], $2::date[]) AS w(symbol, session)
       ON b.symbol = w.symbol AND b.session = w.session`,
    [diag.map((g) => g.symbol), diag.map((g) => g.session)],
  );
  const bars = new Map(daily.rows.map((row) => [`${row.symbol} ${row.session}`, row]));
  const result = judge({
    round,
    minTrades: spec.minTrades,
    trades,
    withNews,
    gapDowns,
    daily: (symbol, session) => {
      const bar = bars.get(`${symbol} ${session}`);
      return bar === undefined ? null : { open: Number(bar.open), close: Number(bar.close) };
    },
  });

  for (const t of trades) {
    await pool.query(
      `INSERT INTO study_trades (run_id, symbol, session, direction, signal, entry, exit, net)
       VALUES ($1, $2, $3, 'short', $4, $5, $6, $7)`,
      [id, t.symbol, t.session, t.gap, t.open?.price ?? null, t.close?.price ?? null, t.net],
    );
  }
  return { id, result, trades, sessions: bySession.size, restricted: restrictedCount };
}
