import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "./index.js";

describe("core", () => {
  it("exports a version", () => {
    expect(CORE_VERSION).toBe("0.0.1");
  });
});
