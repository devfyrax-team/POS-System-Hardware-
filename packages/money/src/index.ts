import Decimal from 'decimal.js';

// One global rule: half-up rounding, high internal precision.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Num = Decimal.Value;
export { Decimal };

export const MONEY_DP = 2;
export const QTY_DP = 4;

export const D = (v: Num): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);

/** Round a monetary value (half-up). Applied per line, then lines are summed. */
export function roundMoney(v: Num, dp: number = MONEY_DP): Decimal {
  return D(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** Round a quantity to numeric(18,4) precision. */
export function roundQty(v: Num): Decimal {
  return D(v).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP);
}

/** Convert a quantity in a selling unit to base units: qty * factor. */
export function convertQty(qty: Num, factor: Num): Decimal {
  return roundQty(D(qty).times(factor));
}

/** Sum of values (already rounded per line). */
export function sum(values: Num[]): Decimal {
  return values.reduce<Decimal>((a, v) => a.plus(v), ZERO);
}

/** Line total = round(unitPrice * qty) - discount, never below zero. */
export function lineTotal(unitPrice: Num, qty: Num, discount: Num = 0): Decimal {
  const gross = roundMoney(D(unitPrice).times(qty));
  const net = gross.minus(roundMoney(discount));
  return net.isNegative() ? ZERO : net;
}

/** Fixed-decimal string for the database (numeric columns). */
export function toDb(v: Num, dp: number = MONEY_DP): string {
  return D(v).toFixed(dp, Decimal.ROUND_HALF_UP);
}

export function toDbQty(v: Num): string {
  return toDb(v, QTY_DP);
}

/** Unit cost keeps 4 dp (cost layers hold more precision than selling prices). */
export function roundCost(v: Num): Decimal {
  return D(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/** Weighted average: (oldQty*oldCost + newQty*newCost) / (oldQty+newQty). */
export function weightedAverage(oldQty: Num, oldCost: Num, newQty: Num, newCost: Num): Decimal {
  const total = D(oldQty).plus(newQty);
  if (total.isZero()) return roundCost(newCost);
  return roundCost(D(oldQty).times(oldCost).plus(D(newQty).times(newCost)).div(total));
}
