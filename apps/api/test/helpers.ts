import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/bootstrap';
import { AuthService } from '../src/auth/auth.service';
import { Db } from '../src/db/db';
import { ShopProvisioningService } from '../src/platform/provisioning.service';

export interface TestCtx {
  app: INestApplication;
  db: Db;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createApp(opts: { rateLimitPerMin?: number; corsOrigins?: string[] } = {}): Promise<TestCtx> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ bodyParser: false });
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready', 'docs'] });
  configureApp(app, { rateLimitPerMin: opts.rateLimitPerMin ?? 1_000_000, corsOrigins: opts.corsOrigins, swagger: false });
  await app.init();
  return {
    app,
    db: app.get(Db),
    http: () => request(app.getHttpServer()) as any,
    close: () => app.close(),
  };
}

export const uniq = (p = 'x') => `${p}-${randomUUID().slice(0, 8)}`;
export const PASSWORD = 'Passw0rd!x';

export interface Shop {
  shopId: string;
  defaultBranchId: string;
  ownerUserId: string;
  ownerEmail: string;
  roleIds: Record<string, string>;
}

export async function provisionShop(
  t: TestCtx,
  opts: { plan?: string; shopType?: 'hardware' | 'paint' | 'both'; name?: string } = {},
): Promise<Shop> {
  const email = `${uniq('owner')}@test.lk`;
  const r = await t.app.get(ShopProvisioningService).create({
    name: opts.name ?? uniq('Shop'),
    shopType: opts.shopType ?? 'hardware',
    planCode: opts.plan ?? 'pro',
    ownerName: 'Owner',
    ownerEmail: email,
    ownerPassword: PASSWORD,
  });
  return { shopId: r.shopId, defaultBranchId: r.defaultBranchId, ownerUserId: r.ownerUserId, ownerEmail: email, roleIds: r.roleIds };
}

/** Logs in and returns a bearer token. */
export async function login(t: TestCtx, email: string, password = PASSWORD, terminalId?: string): Promise<string> {
  const res = await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email, password, terminalId });
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminToken: string | undefined;
export async function platformToken(t: TestCtx): Promise<string> {
  if (adminToken) return adminToken;
  const email = `${uniq('admin')}@platform.lk`;
  await t.app.get(AuthService).createPlatformAdmin(email, 'Admin', PASSWORD);
  const res = await t.http().post('/v1/admin/auth/login').set('x-token-mode', 'body').send({ email, password: PASSWORD });
  adminToken = res.body.accessToken as string;
  return adminToken;
}

/** Creates a user via the API as the owner. Returns the new user's id and email. */
export async function createUser(
  t: TestCtx, ownerToken: string,
  input: { roleId: string; branchId: string | null; name?: string; pin?: string },
) {
  const email = `${uniq('user')}@test.lk`;
  const res = await t.http().post('/v1/users').set(auth(ownerToken)).send({
    email, name: input.name ?? 'User', roleId: input.roleId, branchId: input.branchId, password: PASSWORD,
  });
  if (res.status !== 201) throw new Error(`createUser failed ${res.status}: ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, email };
}
