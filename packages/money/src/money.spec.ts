import { roundMoney, convertQty, lineTotal, sum, toDb, weightedAverage, D } from './index';

describe('money', () => {
  it('rounds half-up, not bankers rounding', () => {
    expect(roundMoney('2.675').toString()).toBe('2.68');
    expect(roundMoney('0.125').toString()).toBe('0.13');
    expect(roundMoney('0.135').toString()).toBe('0.14');
  });
  it('avoids float error', () => {
    expect(sum(['0.1', '0.2']).toString()).toBe('0.3');
    expect(D('0.1').plus('0.2').equals('0.3')).toBe(true);
  });
  it('converts units with 4dp', () => {
    expect(convertQty('3', '12').toString()).toBe('36');
    expect(convertQty('0.3333', '3').toString()).toBe('0.9999');
    expect(convertQty('1', '0.33333').toString()).toBe('0.3333');
  });
  it('rounds per line then sums', () => {
    const a = lineTotal('3.333', '3'); // 9.999 -> 10.00
    const b = lineTotal('3.333', '3');
    expect(sum([a, b]).toString()).toBe('20');
  });
  it('applies discount and never goes negative', () => {
    expect(lineTotal('100', '2', '50').toString()).toBe('150');
    expect(lineTotal('10', '1', '50').toString()).toBe('0');
  });
  it('formats for db', () => {
    expect(toDb('5')).toBe('5.00');
    expect(toDb('1.005')).toBe('1.01');
  });
  it('weighted average cost', () => {
    expect(weightedAverage('10', '100', '10', '120').toString()).toBe('110');
    expect(weightedAverage('0', '0', '5', '80').toString()).toBe('80');
  });
});
