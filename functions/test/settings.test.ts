import {describe, expect, it} from "vitest";
import {minRefreshIntervalMs} from "../src/settings";

describe("the minimum refresh interval", () => {
  it.each([[undefined], [""], ["  "], ["0"]])("is off for %j", (value) => {
    expect(minRefreshIntervalMs(value)).toBe(0);
  });

  it("is given in minutes", () => {
    expect(minRefreshIntervalMs("30")).toBe(30 * 60_000);
    expect(minRefreshIntervalMs(" 1.5 ")).toBe(90_000);
    expect(minRefreshIntervalMs("1440")).toBe(24 * 60 * 60_000);
  });

  // A guard that is silently off is worse than one that is loudly broken.
  it.each([["30m"], ["true"], ["-5"], ["NaN"], ["Infinity"], ["1441"]])("refuses %j rather than quietly staying off", (value) => {
    expect(() => minRefreshIntervalMs(value)).toThrow(/MEDIATOR_MIN_REFRESH_INTERVAL_MINUTES/);
  });
});
