import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../common/config';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Minimal HMAC-signed tokens (access tokens, approval tokens). Payload carries `exp` (unix seconds). */
@Injectable()
export class TokenService {
  private secret = () => config().jwtSecret;

  sign(payload: Record<string, unknown>, ttlSec: number): string {
    const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
    const sig = createHmac('sha256', this.secret()).update(body).digest();
    return `${body}.${b64(sig)}`;
  }

  verify<T = any>(token: string | undefined | null): T | null {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.secret()).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null;
      return p as T;
    } catch {
      return null;
    }
  }

  static newOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  static hashOpaque(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
