import Decimal from "decimal.js";
import { AppError } from "./errors";

// Isolated configuration: a third-party module cannot change our rounding mode.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const decimalPattern = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/;
export function exactDecimal(value: string) {
  if (typeof value !== "string" || !decimalPattern.test(value))
    throw new AppError("INVALID_DECIMAL");
  return new D(value);
}
export function quantity(value: string) {
  const result = exactDecimal(value);
  if (result.isNegative()) throw new AppError("INVALID_QUANTITY");
  return result;
}
export function minorUnits(value: string): bigint {
  return BigInt(exactDecimal(value).times(100).toDecimalPlaces(0).toFixed(0));
}
export function lineAmount(price: string, count: string): bigint {
  const p = exactDecimal(price);
  if (p.isNegative()) throw new AppError("INVALID_PRICE");
  return BigInt(
    p.times(quantity(count)).times(100).toDecimalPlaces(0).toFixed(0),
  );
}
export function minorToDecimal(value: bigint) {
  return new D(value.toString()).div(100).toFixed(2);
}
export function marginPercent(
  revenueMinor: bigint,
  costMinor: bigint,
): string | null {
  if (revenueMinor === 0n) return null;
  return new D((revenueMinor - costMinor).toString())
    .div(revenueMinor.toString())
    .times(100)
    .toFixed(2);
}
