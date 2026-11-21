import { describe, expect, it } from 'vitest';
import { centsToDecimal, fmtCents, lineCents, money, parseScaled, qtyText, toCents } from './money';

describe('money preview (no floats)', () => {
  it('parses decimal strings exactly', () => {
    expect(parseScaled('0.1') + parseScaled('0.2')).toBe(parseScaled('0.3'));
    expect(parseScaled('1250.5000')).toBe(12505000n);
    expect(parseScaled('')).toBe(0n);
    expect(parseScaled('abc')).toBe(0n);
  });
  it('rounds a line half-up to cents like the server', () => {
    expect(lineCents('3.333', '3')).toBe(1000n); // 9.999 -> 10.00
    expect(lineCents('380', '2.5')).toBe(95000n);
    expect(lineCents('100', '2', '50')).toBe(15000n);
    expect(lineCents('10', '1', '50')).toBe(0n); // never negative
    expect(lineCents('2.675', '1')).toBe(268n); // half-up, not bankers
  });
  it('formats with thousands separators', () => {
    expect(fmtCents(253000n)).toBe('2,530.00');
    expect(money('1250.5')).toBe('1,250.50');
    expect(money(null)).toBe('0.00');
    expect(fmtCents(-5n)).toBe('-0.05');
  });
  it('quantities and decimal strings', () => {
    expect(qtyText('12.5000')).toBe('12.5');
    expect(qtyText('3.0000')).toBe('3');
    expect(centsToDecimal(toCents('19.995'))).toBe('20.00');
  });
});
