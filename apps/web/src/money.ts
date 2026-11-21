// Money on screen is a PREVIEW: the server recomputes every price and total. Still, we never use floats:
// amounts are parsed from decimal strings into scaled BigInts.

const S = 10000n; // 4 decimal places

export function parseScaled(v: string | number | null | undefined): bigint {
  const s = String(v ?? '0').trim();
  if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '-' || s === '.') return 0n;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const n = BigInt(i || '0') * S + BigInt((f + '0000').slice(0, 4));
  return neg ? -n : n;
}

/** price x qty, rounded half-up to whole cents (scaled by 100). */
export function lineCents(price: string, qty: string, discount = '0'): bigint {
  const prod = parseScaled(price) * parseScaled(qty); // scale 1e8
  const cents = (prod + 500000n) / 1000000n; // -> scale 1e2, half-up
  const d = (parseScaled(discount) + 50n) / 100n;
  const out = cents - d;
  return out < 0n ? 0n : out;
}

export const toCents = (v: string | number | null | undefined): bigint => (parseScaled(v) + 50n) / 100n;

export function fmtCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Display a decimal string from the API (e.g. "1250.5000") as 1,250.50 */
export const money = (v: string | number | null | undefined): string => fmtCents(toCents(v));

/** "12.5000" -> "12.5", "3.0000" -> "3" */
export const qtyText = (v: string | number | null | undefined): string => {
  const s = String(v ?? '0');
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

export const centsToDecimal = (c: bigint): string => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};
