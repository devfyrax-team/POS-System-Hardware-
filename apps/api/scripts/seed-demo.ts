/**
 * Demo data through the public API: one paint+hardware shop with an owner, manager, cashier, a till, products,
 * stock, a supplier and a credit customer.   API_URL=http://localhost:3000 npm run seed:demo -w apps/api
 * Needs the Super Admin from `npm run migrate` (PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD).
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = { email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@pos.lk', password: process.env.PLATFORM_ADMIN_PASSWORD ?? 'Admin#12345' };
const PW = 'Demo#12345';

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-token-mode': 'body', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const admin = (await call('POST', '/admin/auth/login', undefined, ADMIN)).accessToken;
  const stamp = Date.now().toString().slice(-5);
  const shop = await call('POST', '/admin/shops', admin, { name: `Demo Hardware & Paint ${stamp}`, shopType: 'both', planCode: 'pro', ownerName: 'Nimal Perera', ownerEmail: `owner${stamp}@demo.lk`, ownerPassword: PW });
  const ownerEmail = `owner${stamp}@demo.lk`;
  // tinting is paint-only and not in the Pro plan: grant it to this shop (Super Admin decision), plus profit reports
  await call('PUT', `/admin/shops/${shop.shopId}/features`, admin, { key: 'colour_tinting', enabled: true, reason: 'demo' });
  await call('PUT', `/admin/shops/${shop.shopId}/features`, admin, { key: 'advanced_profit', enabled: true, reason: 'demo' });
  const owner = (await call('POST', '/auth/login', undefined, { email: ownerEmail, password: PW })).accessToken;
  const roles = await call('GET', '/roles', owner);
  const role = (k: string) => roles.find((r: any) => r.system_key === k).id;
  const branchId = shop.defaultBranchId;
  const mk = async (name: string, key: string) => {
    const email = `${key}${stamp}@demo.lk`;
    const u = await call('POST', '/users', owner, { name, email, roleId: role(key), branchId, password: PW });
    await call('PUT', `/users/${u.id}/pin`, owner, { pin: key === 'manager' ? '1234' : '1111' });
    return email;
  };
  const managerEmail = await mk('Kamal Silva', 'manager');
  const cashierEmail = await mk('Saman Fernando', 'cashier');
  const storekeeperEmail = await mk('Ruwan Jayasinghe', 'storekeeper');
  await call('POST', '/terminals', owner, { branchId, name: 'Counter 1', prefix: 'MAIN-T1' });
  await call('POST', '/terminals', owner, { branchId, name: 'Counter 2', prefix: 'MAIN-T2' });

  const supplier = await call('POST', '/suppliers', owner, { name: 'Lanka Hardware Traders', returnTerms: 'Returnable until 30 days before expiry', paymentTermsDays: 30 });
  const items: [string, string, string, string, string, Record<string, unknown>?][] = [
    ['Wire Nail 2 inch', 'kg', '380', '300', '40', { decimalQty: true, minLevel: '10', favourite: true }],
    ['Hex Bolt M8 x 50', 'pcs', '12', '8', '500', { minLevel: '100', favourite: true }],
    ['Cement 50kg Bag', 'bag', '2150', '1900', '60', { minLevel: '20', favourite: true }],
    ['PVC Pipe 1/2 inch', 'm', '145', '110', '300', { decimalQty: true, units: [{ unit: 'length', factor: '4' }] }],
    ['Claw Hammer', 'pcs', '1650', '1200', '12', { minLevel: '4' }],
    ['LED Bulb 9W', 'pcs', '320', '240', '80', { favourite: true }],
    ['Emulsion White 4L', 'pcs', '8900', '7000', '24', { trackBatches: true, shelfLifeDays: 730, minLevel: '6', category: 'Paint', favourite: true }],
    ['Weather Shield Base 10L', 'L', '1450', '1100', '100', { decimalQty: true, trackBatches: true, shelfLifeDays: 730, category: 'Paint' }],
    ['Colorant Blue', 'ml', '3', '2', '2000', { decimalQty: true, category: 'Colorant' }],
    ['Colorant Red', 'ml', '3', '2', '2000', { decimalQty: true, category: 'Colorant' }],
  ];
  const lines: any[] = [];
  const expiry = new Date(Date.now() + 150 * 86400000).toISOString().slice(0, 10);
  let n = 0;
  for (const [name, unit, price, cost, qty, extra] of items) {
    const p = await call('POST', '/products', owner, { name, baseUnit: unit, price, ...extra });
    lines.push({ productId: p.id, qty, unitCost: cost, ...(extra?.trackBatches ? { batchNo: `B-${++n}`, expiryDate: expiry } : {}) });
  }
  await call('POST', '/purchases', owner, { supplierId: supplier.id, supplierInvoiceNo: 'INV-1001', lines });
  await call('POST', '/customers', owner, { name: 'Perera Contractors', phone: '0771234567', type: 'contractor', creditLimit: '100000' });

  console.log('\nDemo shop ready. Sign in at http://localhost:5400/login');
  console.log(`  Owner        ${ownerEmail}   / ${PW}`);
  console.log(`  Manager      ${managerEmail}   / ${PW}   (approval PIN 1234)`);
  console.log(`  Cashier      ${cashierEmail}   / ${PW}   (PIN 1111)`);
  console.log(`  Storekeeper  ${storekeeperEmail}   / ${PW}`);
  console.log(`  Platform     http://localhost:5400/admin/login   ${ADMIN.email} / ${ADMIN.password}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
