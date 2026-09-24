-- Up Migration
-- Official auction prints (Docs/Pre-Registration-Round-2.md, section 4): the price an order on the open or
-- on the close fills at. One row per lookup. A null price means the lookup found no auction print, which
-- is itself the answer: the symbol-session is not traded.
CREATE TABLE auction_prints (
  symbol text NOT NULL,
  session date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('open', 'close')),
  price bigint CHECK (price IS NULL OR price > 0),
  size bigint,
  at timestamptz,
  exchange text,
  PRIMARY KEY (session, symbol, kind)
);

-- Down Migration
DROP TABLE IF EXISTS auction_prints;
