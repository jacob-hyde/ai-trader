#!/usr/bin/env python3
"""Independent reference for the indicator tests. Writes indicators.reference.json next to this file.

Standard library only. Every value is computed from the textbook definition in exact rational
arithmetic, in a different language from the implementation, so agreement is a real cross-check and
not the same code run twice.

Definitions:
  ATR(n): Wilder. True range of the first bar is high minus low. The first ATR is the simple mean of
    the first n true ranges, after that atr = prev + (tr - prev) / n.
  RSI(n): Wilder. Gains and losses from close to close. The first averages are simple means of the
    first n changes, after that the same smoothing. RSI is 100 when the average loss is zero.
  Session VWAP: sum(price * volume) / sum(volume) over the session so far. price is the bar's own vwap
    when it has one, else the typical price (high + low + close) / 3. Rounded half up to a whole unit.
  RVOL: today's cumulative volume through minute m over the mean, across the previous 14 sessions, of
    their cumulative volume through the same minute. Floored to whole basis points. The opening value
    is the same ratio frozen at minute 4 (the first five minutes) and is known from the first bar at
    or past minute 4.

Prices are integer counts of $0.0001. Run from anywhere: python3 indicators_reference.py
"""

import json
from fractions import Fraction
from math import floor
from pathlib import Path

PERIOD = 14
BASELINE_SESSIONS = 14
OPENING_MINUTES = 5
SESSIONS = 17
MINUTES = 8
# (session index, minute) pairs with no bar, to exercise gaps in the volume curves.
MISSING = {(2, 4), (6, 2), (15, 4), (15, 5), (16, 0)}
# Sessions whose bars carry their own vwap. The rest fall back to the typical price.
WITH_BAR_VWAP = {0, 3, 15, 16}


def lcg(seed):
    state = seed
    while True:
        state = (1103515245 * state + 12345) % 2**31
        yield state


def make_bars():
    rng = lcg(20260921)
    bars = []
    close = 200_000
    for s in range(SESSIONS):
        session = f"2026-01-{s + 5:02d}"
        for m in range(MINUTES):
            if (s, m) in MISSING:
                continue
            open_ = close + (next(rng) % 7 - 3) * 100
            close = max(open_ + (next(rng) % 21 - 10) * 100, 50_000)
            high = max(open_, close) + (next(rng) % 6) * 100
            low = min(open_, close) - (next(rng) % 6) * 100
            volume = 0 if next(rng) % 23 == 0 else 1_000 + next(rng) % 49_000
            if m < OPENING_MINUTES and s % 5 == 1:
                volume *= 4
            vwap = low + next(rng) % (high - low + 1) if s in WITH_BAR_VWAP else None
            bars.append(
                {
                    "session": session,
                    "minuteOfSession": m,
                    "open": open_,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": volume,
                    "vwap": vwap,
                }
            )
    return bars


def wilder(values, n):
    out = []
    average = None
    for i, value in enumerate(values):
        if i + 1 < n:
            out.append(None)
        elif i + 1 == n:
            average = sum(values[:n], Fraction(0)) / n
            out.append(average)
        else:
            average = average + (value - average) / n
            out.append(average)
    return out


def atr(bars, n):
    ranges = []
    previous_close = None
    for bar in bars:
        tr = bar["high"] - bar["low"]
        if previous_close is not None:
            tr = max(tr, abs(bar["high"] - previous_close), abs(bar["low"] - previous_close))
        ranges.append(Fraction(tr))
        previous_close = bar["close"]
    return wilder(ranges, n)


def rsi(closes, n):
    gains, losses = [], []
    for before, after in zip(closes, closes[1:]):
        change = after - before
        gains.append(Fraction(max(change, 0)))
        losses.append(Fraction(max(-change, 0)))
    out = [None]
    for gain, loss in zip(wilder(gains, n), wilder(losses, n)):
        if gain is None:
            out.append(None)
        elif loss == 0:
            out.append(Fraction(100))
        else:
            out.append(100 - 100 / (1 + gain / loss))
    return out


def round_half_up(value):
    return floor(value + Fraction(1, 2))


def session_vwap(bars):
    out = []
    session, numerator, volume = None, Fraction(0), 0
    for bar in bars:
        if bar["session"] != session:
            session, numerator, volume = bar["session"], Fraction(0), 0
        price = (
            Fraction(bar["vwap"])
            if bar["vwap"] is not None
            else Fraction(bar["high"] + bar["low"] + bar["close"], 3)
        )
        numerator += price * bar["volume"]
        volume += bar["volume"]
        out.append(round_half_up(numerator / volume) if volume > 0 else None)
    return out


def cumulative_through(session_bars, minute):
    return sum(bar["volume"] for bar in session_bars if bar["minuteOfSession"] <= minute)


def rvol(bars):
    by_session = {}
    for bar in bars:
        by_session.setdefault(bar["session"], []).append(bar)
    order = list(by_session)

    def ratio(session, minute):
        baseline = order[: order.index(session)][-BASELINE_SESSIONS:]
        if len(baseline) < BASELINE_SESSIONS:
            return None
        denominator = sum(cumulative_through(by_session[b], minute) for b in baseline)
        if denominator == 0:
            return None
        today = cumulative_through(by_session[session], minute)
        return floor(Fraction(today * BASELINE_SESSIONS * 10_000, denominator))

    running, opening = [], []
    for bar in bars:
        minute = bar["minuteOfSession"]
        running.append(ratio(bar["session"], minute))
        window_closed = minute >= OPENING_MINUTES - 1
        opening.append(ratio(bar["session"], OPENING_MINUTES - 1) if window_closed else None)
    return running, opening


def as_float(value):
    return None if value is None else float(value)


def main():
    bars = make_bars()
    running, opening = rvol(bars)
    reference = {
        "period": PERIOD,
        "baselineSessions": BASELINE_SESSIONS,
        "openingMinutes": OPENING_MINUTES,
        "bars": bars,
        "atr": [as_float(v) for v in atr(bars, PERIOD)],
        "rsi": [as_float(v) for v in rsi([bar["close"] for bar in bars], PERIOD)],
        "vwap": session_vwap(bars),
        "rvolRunning": running,
        "rvolOpening": opening,
    }
    lines = ["{"]
    keys = list(reference)
    for key in keys:
        value = reference[key]
        comma = "" if key == keys[-1] else ","
        if key == "bars":
            rows = ",\n".join("    " + json.dumps(bar) for bar in value)
            lines.append(f'  "bars": [\n{rows}\n  ]{comma}')
        else:
            lines.append(f'  "{key}": {json.dumps(value)}{comma}')
    lines.append("}")
    target = Path(__file__).with_name("indicators.reference.json")
    target.write_text("\n".join(lines) + "\n")
    print(f"wrote {target.name}: {len(bars)} bars")


if __name__ == "__main__":
    main()
