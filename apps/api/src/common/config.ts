export interface AppConfig {
  databaseUrl: string;
  adminDatabaseUrl: string;
  jwtSecret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  cookieSecure: boolean;
}

/** Read lazily so tests can set env before creating the app. */
export function config(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:5433/pos',
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/pos',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    accessTtlSec: Number(process.env.ACCESS_TTL_SEC ?? 900),
    refreshTtlSec: Number(process.env.REFRESH_TTL_SEC ?? 60 * 60 * 24 * 30),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
  };
}
