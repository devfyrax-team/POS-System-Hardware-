import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'crypto';

// Argon2id is the default algorithm of @node-rs/argon2.
export const hashSecret = (plain: string): Promise<string> => hash(plain);

export async function verifySecret(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

export const tempPassword = (): string => randomBytes(9).toString('base64url');
