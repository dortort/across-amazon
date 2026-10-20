import { describe, expect, it } from "vitest";
import { convertMoney, deliveredTotal, deliveredTotalIn, parseLocalizedNumber, parseMoney, sumMoney } from "../../src/shared/money";
import type { FxTable, Money, PriceBreakdown } from "../../src/shared/types";

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

function eur(amount: number): Money {
  return { amount, currency: "EUR" };
}

const charges: PriceBreakdown = { item: eur(37.2), shipping: eur(4.5), importFees: eur(3.2) };

describe("deliveredTotal", () => {
  it("adds item, shipping and import fees rounded to cents", () => {
    expect(deliveredTotal(charges)).toEqual(eur(44.9));
  });

  it("trusts a displayed total above the sum of the charges", () => {
    expect(deliveredTotal({ ...charges, totalDisplayed: eur(46) })).toEqual(eur(46));
  });

  it("trusts a displayed total equal to the sum despite floating point drift", () => {
    expect(deliveredTotal({ ...charges, totalDisplayed: eur(44.9) })).toEqual(eur(44.9));
  });

  it("ignores a displayed total below the sum of the charges", () => {
    expect(deliveredTotal({ ...charges, totalDisplayed: eur(37.2) })).toEqual(eur(44.9));
  });

  it("sums only the charges that are known", () => {
    expect(deliveredTotal({ item: eur(37.2) })).toEqual(eur(37.2));
    expect(deliveredTotal({ item: eur(37.2), shipping: eur(4.5) })).toEqual(eur(41.7));
    expect(deliveredTotal({ item: eur(37.2), importFees: eur(3.2) })).toEqual(eur(40.4));
  });

  it("compares the displayed total against the known charges only", () => {
    expect(deliveredTotal({ item: eur(37.2), shipping: eur(4.5), totalDisplayed: eur(44.9) })).toEqual(eur(44.9));
    expect(deliveredTotal({ item: eur(37.2), shipping: eur(4.5), totalDisplayed: eur(40) })).toEqual(eur(41.7));
  });

  it("ignores a displayed total in another currency and keeps the sum", () => {
    expect(deliveredTotal({ ...charges, totalDisplayed: { amount: 99, currency: "USD" } })).toEqual(eur(44.9));
  });

  it("returns undefined when the charges are in different currencies", () => {
    expect(deliveredTotal({ ...charges, shipping: { amount: 4.5, currency: "USD" } })).toBeUndefined();
    expect(
      deliveredTotal({ ...charges, importFees: { amount: 3.2, currency: "GBP" }, totalDisplayed: eur(50) })
    ).toBeUndefined();
  });

  it("returns undefined without a breakdown", () => {
    expect(deliveredTotal(undefined)).toBeUndefined();
  });

  it("keeps whole yen amounts whole", () => {
    const yen = (amount: number): Money => ({ amount, currency: "JPY" });
    expect(deliveredTotal({ item: yen(4200), shipping: yen(500), importFees: yen(300), totalDisplayed: yen(4200) })).toEqual(
      yen(5000)
    );
  });
});

describe("deliveredTotalIn", () => {
  const fxTable: FxTable = { base: "EUR", date: "2026-10-16", rates: { EUR: 1, USD: 1.08, GBP: 0.852, CHF: 0.94 }, source: "ECB" };
  const poundsAndFrancs: PriceBreakdown = { item: { amount: 574.97, currency: "GBP" }, shipping: { amount: 252.53, currency: "CHF" } };

  it("converts each charge into the target currency and sums them when the charges are in different currencies", () => {
    expect(deliveredTotalIn(poundsAndFrancs, "GBP", fxTable)).toEqual({ amount: 803.86, currency: "GBP" });
    expect(deliveredTotalIn(poundsAndFrancs, "CHF", fxTable)).toEqual({ amount: 886.89, currency: "CHF" });
    expect(deliveredTotalIn(poundsAndFrancs, "USD", fxTable)).toEqual({ amount: 1018.98, currency: "USD" });
  });

  it("converts the delivered total of charges in one currency as a whole, displayed total included", () => {
    expect(deliveredTotalIn(charges, "EUR", fxTable)).toEqual(eur(44.9));
    expect(deliveredTotalIn({ ...charges, totalDisplayed: eur(46) }, "USD", fxTable)).toEqual({ amount: 49.68, currency: "USD" });
  });

  it("ignores a displayed total when the charges are in different currencies", () => {
    expect(deliveredTotalIn({ ...poundsAndFrancs, totalDisplayed: { amount: 900, currency: "GBP" } }, "GBP", fxTable)).toEqual({
      amount: 803.86,
      currency: "GBP"
    });
  });

  it("returns undefined when a charge or the target has no conversion path", () => {
    expect(deliveredTotalIn({ ...poundsAndFrancs, shipping: { amount: 10, currency: "SEK" } }, "GBP", fxTable)).toBeUndefined();
    expect(deliveredTotalIn(charges, "SEK", fxTable)).toBeUndefined();
  });

  it("returns undefined without a breakdown", () => {
    expect(deliveredTotalIn(undefined, "USD", fxTable)).toBeUndefined();
  });
});
