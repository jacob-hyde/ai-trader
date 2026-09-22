/**
 * Turns a session and a minute into the timestamp an order or a fill carries.
 *
 * Core never reads a clock, and a replayed bar knows only its session and minute. The clock is what
 * turns that into an instant. A replay from stored rows passes the rows' real timestamps through. The
 * synthetic replay has no real time, so it labels minutes from 13:30Z, which is 09:30 New York in
 * summer. A label, not a calendar: it exists so events sort and print, and nothing downstream should
 * read the hour off it.
 */

import type { IsoTimestamp, SessionDate } from "@trader/contracts";

export type SessionClock = (session: SessionDate, minuteOfSession: number) => IsoTimestamp;

export const labelClock: SessionClock = (session, minuteOfSession) => {
  const totalMinutes = 13 * 60 + 30 + minuteOfSession;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${session}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00.000Z`;
};
