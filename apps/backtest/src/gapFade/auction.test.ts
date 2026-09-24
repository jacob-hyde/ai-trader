import { describe, expect, it } from "vitest";
import { type AuctionTrade, auctionPrint } from "./auction.js";

const trade = (
  at: number,
  price: number,
  size: number,
  exchange: string,
  conditions: string[],
): AuctionTrade => ({
  at,
  price,
  size,
  exchange,
  conditions,
});

describe("the official auction print", () => {
  // AAPL on 2019-05-14, as SIP reported the open: a few venues' opening prints and the listing cross.
  const open = [
    trade(1, 186.4, 100, "P", [" "]),
    trade(2, 186.33, 530_202, "T", ["@", "O", "X"]),
    trade(3, 186.33, 530_202, "T", ["@", "O", "X"]),
    trade(4, 186.35, 300, "Z", ["@", "O"]),
    trade(5, 186.36, 1_000, "T", [" "]),
  ];

  it("is the largest print carrying the kind's condition, the earliest on a tie", () => {
    expect(auctionPrint(open, "open")).toEqual({ price: 1_863_300, size: 530_202, at: 2, exchange: "T" });
  });

  it("reads the closing condition for the close, and the official-price conditions where only they appear", () => {
    const close = [
      trade(10, 188.72, 500, "P", ["@", "6"]),
      trade(11, 188.66, 2_573_089, "T", ["@", "6", "X"]),
    ];
    expect(auctionPrint(close, "close")?.price).toBe(1_886_600);
    expect(auctionPrint(close, "open")).toBeNull();
    expect(auctionPrint([trade(1, 48.53, 10, "N", ["Q"])], "open")?.price).toBe(485_300);
    expect(auctionPrint([trade(1, 48.69, 10, "N", ["M"])], "close")?.price).toBe(486_900);
  });

  it("is nothing without an auction print", () => {
    expect(auctionPrint([trade(1, 10, 100, "D", [" "])], "open")).toBeNull();
    expect(auctionPrint([], "close")).toBeNull();
  });
});
