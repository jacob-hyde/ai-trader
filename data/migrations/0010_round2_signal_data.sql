-- Up Migration
-- Round 2's signal-time data (Docs/Pre-Registration-Round-2.md): what was known before the open, and
-- the news. Prices are whole $0.0001 units, as in the bar store.

-- The last pre-market trade at or before 09:25 New York, per eligible symbol-session, from SIP 5-minute
-- bars that closed by then, and the pre-market volume from 04:00. A symbol with no pre-market trade has
-- no row; premarket_loads says which sessions were read and for how many symbols.
CREATE TABLE premarket_last (
  symbol text NOT NULL,
  session date NOT NULL,
  price bigint NOT NULL CHECK (price > 0),
  volume bigint NOT NULL,
  -- When the bar holding that trade closed.
  as_of timestamptz NOT NULL,
  PRIMARY KEY (session, symbol)
);

CREATE TABLE premarket_loads (
  session date PRIMARY KEY,
  -- Eligible symbols asked for.
  symbols integer NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);

-- News articles as Alpaca's feed has them, ticker at time. created_at is first publication.
CREATE TABLE news_articles (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  headline text NOT NULL,
  summary text NOT NULL,
  source text NOT NULL,
  symbols text[] NOT NULL
);
CREATE INDEX news_articles_created ON news_articles (created_at);
CREATE INDEX news_articles_symbols ON news_articles USING gin (symbols);

-- Which symbol-sessions had their overnight window (the prior session's close to 09:25) read from the
-- feed. An article is in news_articles whichever query found it; this says the window was asked.
CREATE TABLE news_windows (
  symbol text NOT NULL,
  session date NOT NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  PRIMARY KEY (session, symbol)
);

-- Down Migration
DROP TABLE IF EXISTS news_windows;
DROP TABLE IF EXISTS news_articles;
DROP TABLE IF EXISTS premarket_loads;
DROP TABLE IF EXISTS premarket_last;
