import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { Public, PlatformOnly } from './auth/decorators';
import { MetricsService } from './common/bootstrap';
import { Db } from './db/db';

@Controller()
export class HealthController {
  constructor(private readonly db: Db, private readonly metrics: MetricsService) {}

  /** Liveness: the process is up. */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Readiness: the database answers. Used by the load balancer and deploy checks. */
  @Public()
  @Get('health/ready')
  async ready() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ status: 'database unavailable' });
    }
  }

  /** Prometheus-style counters for the platform team. */
  @PlatformOnly()
  @Get('admin/metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metricsText() {
    const jobs = (await this.db.platform(async (tx) => (await tx.query(`SELECT status, count(*)::int c FROM job GROUP BY status`)).rows)) as { status: string; c: number }[];
    const extra: Record<string, number> = {};
    for (const j of jobs) extra[`pos_jobs{status="${j.status}"}`] = j.c;
    return this.metrics.render(extra);
  }
}
