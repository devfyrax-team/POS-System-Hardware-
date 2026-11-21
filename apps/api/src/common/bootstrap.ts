import { INestApplication, Injectable, Logger, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { json, urlencoded } from 'express';
import { Observable, tap } from 'rxjs';
import { config } from './config';
import { RateLimiter } from './rate-limiter';

/** In-process counters, exposed to the platform team at /v1/admin/metrics (Prometheus text format). */
@Injectable()
export class MetricsService {
  readonly startedAt = Date.now();
  requests = 0;
  errors5xx = 0;
  errors4xx = 0;
  slow = 0;
  private byStatus = new Map<number, number>();

  record(status: number, ms: number) {
    this.requests++;
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
    if (status >= 500) this.errors5xx++;
    else if (status >= 400) this.errors4xx++;
    if (ms > 1000) this.slow++;
  }

  render(extra: Record<string, number> = {}): string {
    const lines = [
      '# TYPE pos_requests_total counter', `pos_requests_total ${this.requests}`,
      '# TYPE pos_errors_total counter', `pos_errors_total{class="5xx"} ${this.errors5xx}`, `pos_errors_total{class="4xx"} ${this.errors4xx}`,
      '# TYPE pos_slow_requests_total counter', `pos_slow_requests_total ${this.slow}`,
      '# TYPE pos_uptime_seconds gauge', `pos_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      ...[...this.byStatus.entries()].map(([s, n]) => `pos_responses_total{status="${s}"} ${n}`),
      ...Object.entries(extra).map(([k, v]) => `${k} ${v}`),
    ];
    return lines.join('\n') + '\n';
  }
}

/** Request id, access log with duration, slow-request warning (> 1 s), and counters. */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  private readonly log = new Logger('HTTP');
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const started = Date.now();
    const done = (status: number) => {
      const ms = Date.now() - started;
      this.metrics.record(status, ms);
      if (ms > 1000) this.log.warn(`SLOW ${req.method} ${req.originalUrl} ${status} ${ms}ms [${req.id}]`);
    };
    return next.handle().pipe(tap({ next: () => done(res.statusCode), error: (e) => done(e?.status ?? e?.getStatus?.() ?? 500) }));
  }
}

export interface SecurityOptions {
  corsOrigins?: string[];
  rateLimitPerMin?: number;
  swagger?: boolean;
}

/**
 * HTTP hardening shared by the real server and the tests: security headers, CORS allow-list, body-size limits,
 * a per-IP rate limit, request ids, and the OpenAPI document.
 */
export function configureApp(app: INestApplication, opts: SecurityOptions = {}) {
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  express.set('trust proxy', 1); // behind Nginx

  // request id + security headers
  app.use((req: any, res: any, next: any) => {
    req.id = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config().cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/v1/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // CORS: only the listed origins, with credentials (cookies)
  const origins = opts.corsOrigins ?? (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin as string | undefined;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(origin && origins.includes(origin) ? 204 : 403).end();
    next();
  });

  // per-IP rate limit (sliding window)
  const max = opts.rateLimitPerMin ?? Number(process.env.RATE_LIMIT_PER_MIN ?? 1200);
  const limiter = new RateLimiter(max, 60_000);
  app.use((req: any, res: any, next: any) => {
    if (req.path === '/health' || req.path.startsWith('/health/')) return next();
    try {
      limiter.check(req.ip ?? 'unknown');
      next();
    } catch {
      res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' });
    }
  });

  // body limits: normal calls are small; bulk import uploads may be large
  app.use('/v1/imports', json({ limit: '15mb' }));
  app.use(json({ limit: '1mb' }), urlencoded({ extended: false, limit: '100kb' }));

  if (opts.swagger !== false) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Hardware & Paint POS API').setDescription('Multi-shop POS: sales, stock, purchasing, credit, paint.').setVersion('1.0').addBearerAuth().addCookieAuth('pos_at').build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }
}
