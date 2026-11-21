import { z, ZodType } from 'zod';
import { E } from './errors';

export { z };

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw E.validation('Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/** Decimal string (money / quantity) validated without floats. */
export const decimalStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'must be a decimal number');

export const positiveDecimal = decimalStr.refine((v) => Number(v) > 0, 'must be greater than zero');
export const nonNegativeDecimal = decimalStr.refine((v) => Number(v) >= 0, 'must not be negative');
export const uuid = z.string().uuid();
