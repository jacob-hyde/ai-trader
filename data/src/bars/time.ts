/**
 * New York wall clock, months, and sessions for the bar store.
 *
 * The exchange runs on New York time and Alpaca's calendar speaks it ("09:30", "13:00"). Everything
 * stored is UTC. The conversion happens here and nowhere else.
 */

const newYork = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
});

function parts(instant: Date): Record<string, string> {
  return Object.fromEntries(newYork.formatToParts(instant).map((part) => [part.type, part.value]));
}

/**
 * Minutes New York is behind UTC on this date: 240 in daylight time, 300 in standard time.
 *
 * Read at noon UTC. The clocks change at 02:00 local on a Sunday, and no session falls on a Sunday, so
 * noon gives the offset every session of that date runs on.
 */
export function newYorkOffsetMinutes(date: string): number {
  const hour = Number(parts(new Date(`${date}T12:00:00Z`))["hour"]);
  return (12 - hour) * 60;
}

/** A New York wall-clock time on a date as a UTC instant, e.g. ("2026-11-27", "13:00") is 18:00Z. */
export function newYorkToUtc(date: string, time: string): Date {
  const utc = Date.parse(`${date}T${time}:00Z`);
  return new Date(utc + newYorkOffsetMinutes(date) * 60_000);
}

/** The New York calendar date of an instant, e.g. 2026-09-22T02:00Z is "2026-09-21". */
export function newYorkDate(instant: Date): string {
  const p = parts(instant);
  return `${p["year"] ?? ""}-${p["month"] ?? ""}-${p["day"] ?? ""}`;
}

/** The first day of the month holding a date or a "YYYY-MM", e.g. "2021-06-17" is "2021-06-01". */
export function monthOf(dateOrMonth: string): string {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(dateOrMonth)) {
    throw new RangeError(`not a date or a month: ${dateOrMonth}`);
  }
  return `${dateOrMonth.slice(0, 7)}-01`;
}

/** The first day of the following month. */
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12
    ? `${String(year + 1)}-01-01`
    : `${String(year)}-${String(index + 1).padStart(2, "0")}-01`;
}

/** The first day of the previous month. */
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 1
    ? `${String(year - 1)}-12-01`
    : `${String(year)}-${String(index - 1).padStart(2, "0")}-01`;
}

/** Every month from the one holding `from` through the one holding `to`, as first days. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const last = monthOf(to);
  for (let month = monthOf(from); month <= last; month = nextMonth(month)) {
    months.push(month);
  }
  return months;
}

/** One regular session: its New York date and its open and close as epoch milliseconds. */
export interface SessionTimes {
  readonly session: string;
  readonly openAt: number;
  readonly closeAt: number;
}

/** A calendar day from Alpaca ("2026-11-27", "09:30", "13:00") as a session in UTC. */
export function sessionTimes(day: {
  readonly date: string;
  readonly open: string;
  readonly close: string;
}): SessionTimes {
  return {
    session: day.date,
    openAt: newYorkToUtc(day.date, day.open).getTime(),
    closeAt: newYorkToUtc(day.date, day.close).getTime(),
  };
}
