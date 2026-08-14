import {
  calculateLineAmountFen,
  fenToMilliYuan,
  formatMilliYuan,
  roundMilliYuanToFen,
} from "@/modules/catalog/unit-price";

import { describe, expect, test } from "vitest";

describe("exact unit price arithmetic", () => {
  test("converts existing fen prices to exact milli-yuan", () => {
    expect(fenToMilliYuan(33)).toBe(330);
  });

  test("rounds a positive milli-yuan amount to fen using half-up", () => {
    expect(roundMilliYuanToFen(324)).toBe(32);
    expect(roundMilliYuanToFen(325)).toBe(33);
    expect(roundMilliYuanToFen(1366)).toBe(137);
  });

  test("rounds only after multiplying the exact unit price by quantity", () => {
    expect(calculateLineAmountFen(2, 325)).toBe(65);
    expect(calculateLineAmountFen(3, 325)).toBe(98);
  });

  test("rejects unsafe, negative, or non-integer input", () => {
    expect(() => calculateLineAmountFen(-1, 325)).toThrow();
    expect(() => calculateLineAmountFen(1.5, 325)).toThrow();
    expect(() => calculateLineAmountFen(Number.MAX_SAFE_INTEGER, 325)).toThrow();
  });

  test.each([
    [325, "¥0.325"],
    [1_366, "¥1.366"],
    [2_930, "¥2.93"],
  ])("formats %i milli-yuan without losing meaningful precision", (value, expected) => {
    expect(formatMilliYuan(value)).toBe(expected);
  });
});
