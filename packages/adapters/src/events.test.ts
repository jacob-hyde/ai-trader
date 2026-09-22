import { describe, expect, it } from "vitest";
import { Emitter } from "./index.js";

type Events = { tick: number; note: string };

describe("Emitter", () => {
  it("delivers to handlers in subscription order and stops delivering after unsubscribe", () => {
    const emitter = new Emitter<Events>();
    const seen: string[] = [];
    const off = emitter.on("tick", (n) => seen.push(`a${String(n)}`));
    emitter.on("tick", (n) => seen.push(`b${String(n)}`));
    emitter.emit("tick", 1);
    off();
    emitter.emit("tick", 2);
    emitter.emit("note", "ignored by tick handlers");
    expect(seen).toEqual(["a1", "b1", "b2"]);
    expect(emitter.listenerCount("tick")).toBe(1);
    expect(emitter.listenerCount("note")).toBe(0);
  });

  it("adds the same handler once and tolerates an event with no handlers", () => {
    const emitter = new Emitter<Events>();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };
    emitter.on("tick", handler);
    emitter.on("tick", handler);
    emitter.emit("tick", 1);
    emitter.emit("note", "nobody listens");
    expect(calls).toBe(1);
  });

  it("lets a throwing handler stop the rest and reach the emitter", () => {
    const emitter = new Emitter<Events>();
    const seen: number[] = [];
    emitter.on("tick", () => {
      throw new Error("boom");
    });
    emitter.on("tick", (n) => seen.push(n));
    expect(() => emitter.emit("tick", 1)).toThrow("boom");
    expect(seen).toEqual([]);
  });

  it("is safe to unsubscribe from inside a handler", () => {
    const emitter = new Emitter<Events>();
    const seen: number[] = [];
    const off = emitter.on("tick", (n) => {
      seen.push(n);
      off();
    });
    emitter.emit("tick", 1);
    emitter.emit("tick", 2);
    expect(seen).toEqual([1]);
  });
});
