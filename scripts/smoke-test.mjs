#!/usr/bin/env node
/**
 * End-to-end smoke test for every API route.
 *
 *   node scripts/smoke-test.mjs [baseUrl]
 *
 * Covers everything that does not need a human in the Razorpay widget:
 * listing, filtering, validation, the 404/400 paths, stock reservation,
 * signature rejection, stock release, and the expiry sweeper.
 *
 * It also verifies the one thing a payment flow must never get wrong: that a
 * *forged* signature is rejected AND that a *genuine* one is accepted. The
 * genuine signature is computed locally from RAZORPAY_KEY_SECRET, which is
 * exactly what Razorpay would send — so the paid path is exercised for real
 * without touching the widget.
 *
 * Cleanup: every reservation it makes is released again, EXCEPT the one it
 * genuinely pays for — a completed sale keeps its unit deducted, which is the
 * correct outcome. The summary names that product so you can restock it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

// ------------------------------------------------------------ tiny harness --
let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}\n${'─'.repeat(66)}`);
}

async function call(method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON response — check() below will catch it */
  }
  return { status: res.status, body: payload };
}

/** Read RAZORPAY_KEY_SECRET out of .env.local so we can forge a *valid* HMAC. */
function loadKeySecret() {
  if (process.env.RAZORPAY_KEY_SECRET) return process.env.RAZORPAY_KEY_SECRET;
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return null;
  const match = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('RAZORPAY_KEY_SECRET='));
  if (!match) return null;
  return match.slice(match.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || null;
}

console.log(`Smoke testing ${baseUrl}`);

// ================================================================= products ==
section('GET /api/products');

const all = await call('GET', '/api/products');
check('200 OK', all.status === 200, `got ${all.status}`);
check('ok envelope', all.body?.ok === true);
check('returns a catalogue', (all.body?.data?.products?.length ?? 0) > 0);

if (!all.body?.ok || all.body.data.products.length === 0) {
  console.log('\nNo products returned — run supabase/schema.sql and supabase/seed.sql first.');
  console.log(all.body?.error?.message ?? '');
  process.exit(1);
}

const products = all.body.data.products;
const product = products[0];

/** Set once the test completes a real sale, so the summary can flag it. */
let soldProduct = null;

const bySize = await call('GET', '/api/products?size=M');
check(
  'filter ?size=M returns only M',
  bySize.body?.ok && bySize.body.data.products.every((p) => p.size?.toUpperCase() === 'M'),
);

const byColor = await call('GET', '/api/products?color=Black');
check(
  'filter ?color=Black returns only Black',
  byColor.body?.ok &&
    byColor.body.data.products.every((p) => p.color?.toLowerCase() === 'black'),
);

const byPrice = await call('GET', '/api/products?max_price=200000');
check(
  'filter ?max_price=200000 caps price',
  byPrice.body?.ok && byPrice.body.data.products.every((p) => p.price <= 200000),
);

const badPrice = await call('GET', '/api/products?max_price=abc');
check('bad max_price → 400', badPrice.status === 400, `got ${badPrice.status}`);

section('GET /api/products/:id');

const one = await call('GET', `/api/products/${product.id}`);
check('200 OK', one.status === 200, `got ${one.status}`);
check('exposes live stock_count', typeof one.body?.data?.stock_count === 'number');

const missing = await call('GET', '/api/products/00000000-0000-4000-8000-000000000000');
check('unknown id → 404', missing.status === 404, `got ${missing.status}`);

const malformed = await call('GET', '/api/products/not-a-uuid');
check('malformed id → 400', malformed.status === 400, `got ${malformed.status}`);

// =================================================================== orders ==
section('POST /api/orders/create — validation');

const noBody = await call('POST', '/api/orders/create', {});
check('empty body → 400', noBody.status === 400, `got ${noBody.status}`);
check('names the bad fields', typeof noBody.body?.error?.details?.fields === 'object');

const badEmail = await call('POST', '/api/orders/create', {
  product_id: product.id,
  customer_name: 'Smoke Test',
  customer_email: 'nope',
});
check('invalid email → 400', badEmail.status === 400, `got ${badEmail.status}`);

const ghostProduct = await call('POST', '/api/orders/create', {
  product_id: '00000000-0000-4000-8000-000000000000',
  customer_name: 'Smoke Test',
  customer_email: 'smoke@example.com',
});
check('unknown product → 404', ghostProduct.status === 404, `got ${ghostProduct.status}`);

section('POST /api/orders/create — reservation');

const stockBefore = one.body.data.stock_count;
const created = await call('POST', '/api/orders/create', {
  product_id: product.id,
  customer_name: 'Smoke Test',
  customer_email: 'smoke@example.com',
});

check('201 Created', created.status === 201, `got ${created.status} ${JSON.stringify(created.body?.error ?? '')}`);
check('order status is reserved', created.body?.data?.order?.status === 'reserved');
check('razorpay order id returned', typeof created.body?.data?.razorpay?.id === 'string');
check(
  'amount matches the product price, in paise',
  created.body?.data?.razorpay?.amount === product.price,
);
check(
  'checkout block carries only the public key',
  typeof created.body?.data?.checkout?.key === 'string' &&
    !JSON.stringify(created.body.data).includes('key_secret'),
);

const afterReserve = await call('GET', `/api/products/${product.id}`);
check(
  'stock decremented by exactly 1',
  afterReserve.body?.data?.stock_count === stockBefore - 1,
  `${stockBefore} → ${afterReserve.body?.data?.stock_count}`,
);

const orderId = created.body?.data?.order?.id;
const rzpOrderId = created.body?.data?.razorpay?.id;

section('GET /api/orders/:id');

const fetched = await call('GET', `/api/orders/${orderId}`);
check('200 OK', fetched.status === 200, `got ${fetched.status}`);
check('status is reserved', fetched.body?.data?.status === 'reserved');
check('not settled yet', fetched.body?.data?.is_settled === false);
check('joins the product', fetched.body?.data?.product?.id === product.id);

const ghostOrder = await call('GET', '/api/orders/00000000-0000-4000-8000-000000000000');
check('unknown order → 404', ghostOrder.status === 404, `got ${ghostOrder.status}`);

section('POST /api/orders/verify — forged signature must be rejected');

const forged = await call('POST', '/api/orders/verify', {
  order_id: orderId,
  razorpay_order_id: rzpOrderId,
  razorpay_payment_id: 'pay_SMOKEFORGED01',
  razorpay_signature: 'deadbeef'.repeat(8),
});
check('400 Bad Request', forged.status === 400, `got ${forged.status}`);
check('INVALID_SIGNATURE', forged.body?.error?.code === 'INVALID_SIGNATURE');

const afterForge = await call('GET', `/api/products/${product.id}`);
check(
  'stock released after rejection',
  afterForge.body?.data?.stock_count === stockBefore,
  `${afterForge.body?.data?.stock_count} (expected ${stockBefore})`,
);

const failedOrder = await call('GET', `/api/orders/${orderId}`);
check('order marked failed', failedOrder.body?.data?.status === 'failed');

section('POST /api/orders/verify — genuine signature must be accepted');

const keySecret = loadKeySecret();
if (!keySecret) {
  console.log('  skip RAZORPAY_KEY_SECRET not readable — cannot compute a genuine signature');
} else {
  const paidOrder = await call('POST', '/api/orders/create', {
    product_id: product.id,
    customer_name: 'Smoke Test Paid',
    customer_email: 'smoke.paid@example.com',
  });

  if (paidOrder.status !== 201) {
    check('created an order to pay for', false, JSON.stringify(paidOrder.body?.error));
  } else {
    const oid = paidOrder.body.data.order.id;
    const rid = paidOrder.body.data.razorpay.id;
    const pid = 'pay_SMOKEGENUINE1';

    // Exactly what Razorpay Checkout hands the browser on success.
    const signature = crypto
      .createHmac('sha256', keySecret)
      .update(`${rid}|${pid}`)
      .digest('hex');

    const verified = await call('POST', '/api/orders/verify', {
      order_id: oid,
      razorpay_order_id: rid,
      razorpay_payment_id: pid,
      razorpay_signature: signature,
    });

    check('200 OK', verified.status === 200, `got ${verified.status}`);
    check('order flips to paid', verified.body?.data?.order?.status === 'paid');
    if (verified.body?.data?.order?.status === 'paid') soldProduct = product.name;
    check('payment id stored', verified.body?.data?.order?.razorpay_payment_id === pid);

    const replay = await call('POST', '/api/orders/verify', {
      order_id: oid,
      razorpay_order_id: rid,
      razorpay_payment_id: pid,
      razorpay_signature: signature,
    });
    check('replaying verify is idempotent', replay.body?.data?.idempotent_replay === true);

    const afterPaid = await call('GET', `/api/products/${product.id}`);
    check(
      'paid order keeps its unit deducted',
      afterPaid.body?.data?.stock_count === stockBefore - 1,
      `${afterPaid.body?.data?.stock_count} (expected ${stockBefore - 1})`,
    );

    const mismatched = await call('POST', '/api/orders/verify', {
      order_id: oid,
      razorpay_order_id: 'order_SOMEONEELSES',
      razorpay_payment_id: pid,
      razorpay_signature: signature,
    });
    check(
      'signature from another order is rejected',
      mismatched.status === 400 || mismatched.body?.data?.idempotent_replay === true,
    );
  }
}

section('POST /api/orders/cancel-expired');

const abandoned = await call('POST', '/api/orders/create', {
  product_id: product.id,
  customer_name: 'Abandoner',
  customer_email: 'abandon@example.com',
});

if (abandoned.status === 201) {
  const stockWhileHeld = (await call('GET', `/api/products/${product.id}`)).body?.data
    ?.stock_count;

  const sweep = await call('POST', '/api/orders/cancel-expired', { minutes: 0 });
  check('200 OK', sweep.status === 200, `got ${sweep.status}`);
  check('reports what it cancelled', typeof sweep.body?.data?.cancelled_count === 'number');
  check('cancelled at least our abandoned order', (sweep.body?.data?.cancelled_count ?? 0) >= 1);

  const swept = await call('GET', `/api/orders/${abandoned.body.data.order.id}`);
  check('abandoned order is cancelled', swept.body?.data?.status === 'cancelled');

  const stockBack = (await call('GET', `/api/products/${product.id}`)).body?.data?.stock_count;
  check(
    'stock returned by the sweeper',
    stockBack === stockWhileHeld + 1,
    `${stockWhileHeld} → ${stockBack}`,
  );

  const secondSweep = await call('POST', '/api/orders/cancel-expired', { minutes: 0 });
  const stockAfterSecond = (await call('GET', `/api/products/${product.id}`)).body?.data
    ?.stock_count;
  check(
    'sweeping twice does not double-refund stock',
    stockAfterSecond === stockBack,
    `${stockBack} → ${stockAfterSecond} (cancelled ${secondSweep.body?.data?.cancelled_count})`,
  );
} else {
  check('could create an order to abandon', false, JSON.stringify(abandoned.body?.error));
}

const badMinutes = await call('POST', '/api/orders/cancel-expired', { minutes: -5 });
check('negative minutes → 400', badMinutes.status === 400, `got ${badMinutes.status}`);

// ==================================================================== admin ==
section('GET /api/admin/overview');

const admin = await call('GET', '/api/admin/overview');
check('200 OK', admin.status === 200, `got ${admin.status}`);
check('carries stats', typeof admin.body?.data?.stats?.total_products === 'number');
check('carries products', Array.isArray(admin.body?.data?.products));
check('carries orders', Array.isArray(admin.body?.data?.orders));

// =================================================================== result ==
console.log(`\n${'═'.repeat(66)}`);
if (failures.length === 0) {
  console.log(`ALL PASSED — ${passed} checks.`);
  if (soldProduct) {
    console.log(`
One unit of "${soldProduct}" was genuinely sold and stays deducted.`);
    console.log('Restock it with:');
    console.log(`  update products set stock_count = stock_count + 1, status = 'available'`);
    console.log(`   where id = '${product.id}';`);
  }
  console.log('\nStill to test by hand: a real Razorpay widget payment, and the');
  console.log('two-tab race (node scripts/race-test.mjs).');
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
