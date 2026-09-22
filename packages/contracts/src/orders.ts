/**
 * Orders, fills, positions, and closed trades: the execution vocabulary.
 *
 * A BracketOrder is what the engine asks for. An Order is what the broker holds, with its lifecycle
 * status. A Fill is one execution against an order. A Position is a holding as it stands. A Trade is a
 * closed round trip with its tax lots, which are required, not optional, so nothing can be logged
 * without them. Day trading is heavy wash-sale territory and the lots are what the calculation needs.
 */

import { z } from "zod";
import { type Fixed, fixedSchema, sharesSchema } from "./money.js";
import { type Direction, directionSchema } from "./signals.js";
import { type IsoTimestamp, type SessionDate, isoTimestampSchema, sessionDateSchema } from "./time.js";

export type Side = "buy" | "sell";
export const SIDES = ["buy", "sell"] as const;
export const sideSchema = z.enum(SIDES);

/** "bracket" carries a stop-loss and a take-profit. "oto" carries the stop-loss only. */
export type OrderClass = "bracket" | "oto";
export const orderClassSchema = z.enum(["bracket", "oto"]);

export type BracketEntry =
  | { readonly type: "stop"; readonly stopPrice: Fixed }
  | { readonly type: "limit"; readonly limitPrice: Fixed }
  | { readonly type: "market" };

export const bracketEntrySchema: z.ZodType<BracketEntry, z.ZodTypeDef, unknown> = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("stop"), stopPrice: fixedSchema }),
    z.object({ type: z.literal("limit"), limitPrice: fixedSchema }),
    z.object({ type: z.literal("market") }),
  ],
);

/**
 * An entry with its exits attached, ready to submit. The protective stop is part of the order, so no
 * position can exist without one. clientOrderId is deterministic for the trade, so a retry dedupes.
 */
export interface BracketOrder {
  readonly clientOrderId: string;
  readonly symbol: string;
  /** Side of the entry. The exits are the opposite side. */
  readonly side: Side;
  readonly quantity: number;
  readonly timeInForce: "day";
  readonly orderClass: OrderClass;
  readonly entry: BracketEntry;
  readonly stopLoss: { readonly stopPrice: Fixed };
  readonly takeProfit: { readonly limitPrice: Fixed } | null;
}

export const bracketOrderSchema: z.ZodType<BracketOrder, z.ZodTypeDef, unknown> = z.object({
  clientOrderId: z.string().min(1).max(48),
  symbol: z.string().min(1),
  side: sideSchema,
  quantity: sharesSchema,
  timeInForce: z.literal("day"),
  orderClass: orderClassSchema,
  entry: bracketEntrySchema,
  stopLoss: z.object({ stopPrice: fixedSchema }),
  takeProfit: z.object({ limitPrice: fixedSchema }).nullable(),
});

/**
 * Where a broker order stands. Terminal states are filled, canceled, rejected, and expired. A replaced
 * order is terminal too: the replacement is a new order that names it as its predecessor.
 */
export type OrderStatus =
  "new" | "accepted" | "partiallyFilled" | "filled" | "canceled" | "replaced" | "rejected" | "expired";
export const ORDER_STATUSES = [
  "new",
  "accepted",
  "partiallyFilled",
  "filled",
  "canceled",
  "replaced",
  "rejected",
  "expired",
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "filled",
  "canceled",
  "replaced",
  "rejected",
  "expired",
];

/** Which leg of a bracket an order is. */
export type OrderLeg = "entry" | "stopLoss" | "takeProfit" | "flatten";
export const orderLegSchema = z.enum(["entry", "stopLoss", "takeProfit", "flatten"]);

export type OrderType = "market" | "limit" | "stop";
export const orderTypeSchema = z.enum(["market", "limit", "stop"]);

/** A broker order as it stands. One per leg: a bracket is three orders sharing a clientOrderId prefix. */
export interface Order {
  /** The broker's id. */
  readonly id: string;
  /** The engine's id for the bracket this leg belongs to. */
  readonly clientOrderId: string;
  readonly leg: OrderLeg;
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly quantity: number;
  readonly filledQuantity: number;
  /** Average price of the filled quantity, null before the first fill. */
  readonly averageFillPrice: Fixed | null;
  readonly limitPrice: Fixed | null;
  readonly stopPrice: Fixed | null;
  readonly status: OrderStatus;
  /** The order this one replaced, when it came from a replace. */
  readonly replaces: string | null;
  readonly submittedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export const orderSchema: z.ZodType<Order, z.ZodTypeDef, unknown> = z
  .object({
    id: z.string().min(1),
    clientOrderId: z.string().min(1),
    leg: orderLegSchema,
    symbol: z.string().min(1),
    side: sideSchema,
    type: orderTypeSchema,
    quantity: sharesSchema,
    filledQuantity: z.number().int().min(0),
    averageFillPrice: fixedSchema.nullable(),
    limitPrice: fixedSchema.nullable(),
    stopPrice: fixedSchema.nullable(),
    status: orderStatusSchema,
    replaces: z.string().min(1).nullable(),
    submittedAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .refine((order) => order.filledQuantity <= order.quantity, {
    message: "filled quantity exceeds the order",
  });

/** One execution against an order. A partially filled order has several. */
export interface Fill {
  readonly id: string;
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: number;
  readonly price: Fixed;
  /** Commission and regulatory fees on this fill, total. */
  readonly fees: Fixed;
  readonly at: IsoTimestamp;
}

export const fillSchema: z.ZodType<Fill, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  clientOrderId: z.string().min(1),
  symbol: z.string().min(1),
  side: sideSchema,
  quantity: sharesSchema,
  price: fixedSchema,
  fees: fixedSchema,
  at: isoTimestampSchema,
});

/**
 * Where a position stands in its life. pendingEntry has a working entry and no shares. open has shares
 * and a working stop. exiting has a flatten or exit order working. closed is done.
 */
export type PositionState = "pendingEntry" | "partiallyFilled" | "open" | "exiting" | "closed";
export const POSITION_STATES = ["pendingEntry", "partiallyFilled", "open", "exiting", "closed"] as const;
export const positionStateSchema = z.enum(POSITION_STATES);

/** A holding as it stands, with the orders that guard it. */
export interface Position {
  readonly symbol: string;
  readonly direction: Direction;
  readonly state: PositionState;
  readonly quantity: number;
  readonly averageEntryPrice: Fixed;
  /** The working protective stop, null only while no shares are held or in the moment it is replaced. */
  readonly stopPrice: Fixed | null;
  readonly takeProfitPrice: Fixed | null;
  /** The bracket that opened it. */
  readonly clientOrderId: string;
  readonly openedAt: IsoTimestamp;
  /** Marked at the last quote. */
  readonly unrealizedPnl: Fixed;
  readonly marketValue: Fixed;
}

export const positionSchema: z.ZodType<Position, z.ZodTypeDef, unknown> = z.object({
  symbol: z.string().min(1),
  direction: directionSchema,
  state: positionStateSchema,
  quantity: z.number().int().min(0),
  averageEntryPrice: fixedSchema,
  stopPrice: fixedSchema.nullable(),
  takeProfitPrice: fixedSchema.nullable(),
  clientOrderId: z.string().min(1),
  openedAt: isoTimestampSchema,
  unrealizedPnl: fixedSchema,
  marketValue: fixedSchema,
});

/** One tax lot: shares bought and sold together, with what they cost and what they brought. */
export interface TaxLot {
  readonly lotId: string;
  readonly openedAt: IsoTimestamp;
  readonly closedAt: IsoTimestamp;
  readonly quantity: number;
  /** Total paid to open, fees included. */
  readonly costBasis: Fixed;
  /** Total received on close, fees deducted. */
  readonly proceeds: Fixed;
  /** Fees on both sides, total. */
  readonly fees: Fixed;
}

export const taxLotSchema: z.ZodType<TaxLot, z.ZodTypeDef, unknown> = z.object({
  lotId: z.string().min(1),
  openedAt: isoTimestampSchema,
  closedAt: isoTimestampSchema,
  quantity: sharesSchema,
  costBasis: fixedSchema,
  proceeds: fixedSchema,
  fees: fixedSchema,
});

export type ExitReason = "stop" | "breakevenStop" | "target" | "eod" | "panic" | "manual";
export const EXIT_REASONS = ["stop", "breakevenStop", "target", "eod", "panic", "manual"] as const;
export const exitReasonSchema = z.enum(EXIT_REASONS);

/** A closed round trip. The unit the scorecard, the tax export, and the trade log all count. */
export interface Trade {
  readonly id: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly setupId: string;
  readonly setupVersion: string;
  readonly session: SessionDate;
  readonly quantity: number;
  readonly averageEntryPrice: Fixed;
  readonly averageExitPrice: Fixed;
  readonly openedAt: IsoTimestamp;
  readonly closedAt: IsoTimestamp;
  readonly exitReason: ExitReason;
  /** The entry and stop the trade was planned at, so R can be measured against them. */
  readonly plannedEntry: Fixed;
  readonly plannedStop: Fixed;
  /** Fill to fill, fees deducted, in dollars. */
  readonly realizedPnl: Fixed;
  /** realizedPnl over the planned risk, in basis points of R. */
  readonly realizedR: number;
  /** At least one. Their quantities sum to the trade's. */
  readonly lots: readonly TaxLot[];
}

export const tradeSchema: z.ZodType<Trade, z.ZodTypeDef, unknown> = z
  .object({
    id: z.string().min(1),
    clientOrderId: z.string().min(1),
    symbol: z.string().min(1),
    direction: directionSchema,
    setupId: z.string().min(1),
    setupVersion: z.string().min(1),
    session: sessionDateSchema,
    quantity: sharesSchema,
    averageEntryPrice: fixedSchema,
    averageExitPrice: fixedSchema,
    openedAt: isoTimestampSchema,
    closedAt: isoTimestampSchema,
    exitReason: exitReasonSchema,
    plannedEntry: fixedSchema,
    plannedStop: fixedSchema,
    realizedPnl: fixedSchema,
    realizedR: z.number().int().safe(),
    lots: z.array(taxLotSchema).min(1),
  })
  .refine((trade) => trade.lots.reduce((sum, lot) => sum + lot.quantity, 0) === trade.quantity, {
    message: "tax lots must account for every share of the trade",
  });

/** The broker's view of the account. */
export interface Account {
  readonly id: string;
  readonly status: string;
  readonly equity: Fixed;
  readonly cash: Fixed;
  readonly buyingPower: Fixed;
  /** Broker leverage, e.g. 4. The self-imposed 1x is applied by the engine on top. */
  readonly multiplier: number;
  readonly tradingBlocked: boolean;
  readonly asOf: IsoTimestamp;
}

export const accountSchema: z.ZodType<Account, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  equity: fixedSchema,
  cash: fixedSchema,
  buyingPower: fixedSchema,
  multiplier: z.number().positive(),
  tradingBlocked: z.boolean(),
  asOf: isoTimestampSchema,
});
