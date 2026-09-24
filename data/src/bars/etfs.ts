/**
 * Candidates for the ETF and ETN exclusion list (Pre-Registration section 3).
 *
 * Every symbol with minute bars loaded could rank in play, so every one is named: from the stored asset
 * snapshot, or failing that from Alpaca's single-asset lookup, which still answers for many products
 * its full list has dropped. Names are sorted three ways for the hand review the registration asks for:
 *
 * - "etp": the name says it is a fund or a note, or names a fund issuer. Excluded unless review keeps it,
 *   such as an issuer's own common stock (Invesco Ltd., WisdomTree Investments).
 * - "review": words ETPs often carry and companies sometimes do (Trust, Bull, 2X, VIX, Futures). Kept
 *   unless review excludes it, such as a closed-end trust holding bullion.
 * - "unnamed": no source knows the symbol. Delisted products among them are added by hand.
 *
 * It prints, it writes nothing. The frozen list is the reviewed file, not this output.
 */

import type pg from "pg";

/** The registration's keywords and fund issuers, and the issuers like them. */
export const ETP_PATTERN =
  /\b(ETFs?|ETNs?|Exchange[- ]Traded|Fund|iShares|SPDR|ProShares|Direxion|Invesco|PowerShares|VanEck|Market Vectors|Vanguard|Global X|WisdomTree|VelocityShares|iPath|MicroSectors|ETRACS|Xtrackers|First Trust|Select Sector|GraniteShares|Teucrium|Grayscale|Sprott|AdvisorShares|Amplify|Roundhill|Defiance|YieldMax|Tuttle|T-Rex|Leverage Shares|Pacer|Barclays|Credit Suisse|UBS AG|Deutsche Bank|Citigroup Global|Goldman Sachs Physical)\b/i;

/** Words ETPs often carry and companies sometimes do. */
export const REVIEW_PATTERN =
  /\b(Trust|Index|Bull|Bear|[1-4](\.\d)?[xX]|Ultra|UltraPro|UltraShort|Inverse|Leveraged|Futures|Daily|Bitcoin|Ether|Ethereum|Crypto|Gold|Silver|Crude|Oil|Natural Gas|Volatility|VIX|Treasury|Bond|Notes?|Shares)\b/i;

export type EtpMatch = "etp" | "review" | "unnamed" | "none";

export function classify(name: string | null): EtpMatch {
  if (name === null) {
    return "unnamed";
  }
  return ETP_PATTERN.test(name) ? "etp" : REVIEW_PATTERN.test(name) ? "review" : "none";
}

export interface NamedSymbol {
  readonly symbol: string;
  readonly name: string | null;
  /** Where the name came from: the stored snapshot, the single-asset lookup, or nowhere. */
  readonly from: "snapshot" | "lookup" | null;
  readonly status: string | null;
  readonly exchange: string | null;
}

/** Every symbol with complete minute bars, with the latest snapshot's name where it has one. */
export async function loadedSymbolNames(pool: pg.Pool): Promise<NamedSymbol[]> {
  const result = await pool.query<{
    symbol: string;
    name: string | null;
    status: string | null;
    exchange: string | null;
  }>(
    `SELECT l.symbol, a.name, a.status, a.exchange
     FROM (SELECT DISTINCT symbol FROM bar_load_checkpoints WHERE timeframe = '1Min' AND status = 'complete') l
     LEFT JOIN LATERAL (
       SELECT name, status, exchange FROM asset_snapshots s WHERE s.symbol = l.symbol
       ORDER BY taken_at DESC, status LIMIT 1
     ) a ON true
     ORDER BY l.symbol`,
  );
  return result.rows.map((row) => ({ ...row, from: row.name === null ? null : "snapshot" }));
}
