import { AppError } from './errors';

/** Small in-memory sliding-window limiter (single API process; move to Redis/PG if scaled out). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  check(key: string): void {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      throw new AppError(429, 'FORBIDDEN', 'Too many attempts. Try again later.');
    }
    arr.push(now);
    this.hits.set(key, arr);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
