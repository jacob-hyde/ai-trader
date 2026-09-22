/**
 * Time on the wire.
 *
 * Instants are ISO 8601 strings in UTC with a trailing Z, as JSON has no better answer and every
 * consumer can parse them. Sessions are ISO dates, the trading day in New York, which sort as strings.
 * Minutes within a session count from the regular open, so 09:30 ET is minute 0. Core never reads a
 * clock; whoever assigns these fields owns the exchange calendar.
 */

import { z } from "zod";

/** An instant, e.g. "2026-09-21T13:30:00.000Z". */
export type IsoTimestamp = string;

/** A trading date, e.g. "2026-09-21". */
export type SessionDate = string;

export const isoTimestampSchema = z.string().datetime({ offset: false });

export const sessionDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a session is an ISO date");

/** Minutes from the regular-session open. 390 minutes in a full day. */
export const minuteOfSessionSchema = z.number().int().min(0).max(1_439);
