import { describe, expect, it } from "vitest";
import { convertMoney, parseLocalizedNumber, parseMoney, sumMoney } from "../../src/shared/money";

describe("money utilities", () => {
  it("parses localized number formats", () => {
    expect(parseLocalizedNumber("1,234.56")).toBe(1234.56);
    expect(parseLocalizedNumber("1.234,56")).toBe(1234.56);
    expect(parseLocalizedNumber("￥1,234")).toBe(1234);
  });

  it("parses money with currency symbols", () => {
    expect(parseMoney("CA$14.99")).toEqual({ amount: 14.99, currency: "CAD" });
    expect(parseMoney("€19,99")).toEqual({ amount: 19.99, currency: "EUR" });
    expect(parseMoney("¥4,200")).toEqual({ amount: 4200, currency: "JPY" });
  });

  it("sums available money parts and tolerates missing optional costs", () => {
    const total = sumMoney(
      [
        { amount: 39.99, currency: "USD" },
        undefined,
        { amount: 3, currency: "USD" }
      ],
      "USD"
    );

    expect(total).toEqual({ amount: 42.99, currency: "USD" });
  });

  it("converts currencies via fx table", () => {
    const converted = convertMoney(
      { amount: 10, currency: "USD" },
      "EUR",
      {
        base: "EUR",
        date: "2026-01-01",
        rates: {
          EUR: 1,
          USD: 1.2,
          GBP: 0.85
        },
        source: "ECB"
      }
    );

    expect(converted).toEqual({ amount: 8.33, currency: "EUR" });
  });
});
