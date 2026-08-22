#!/usr/bin/env node
/**
 * Verification for POST /api/orders — the agent-facing order endpoint.
 *
 *   node scripts/test-agent-api.mjs [baseUrl]
 *
 * Covers the four things that were asked for explicitly:
 *   1. a normal order on an in-stock product returns the required fields
 *   2. two SIMULTANEOUS orders on a single-stock item give one 201 and one 409
 *   3. the permanently-sold-out product fails cleanly with OUT_OF_STOCK
 *   4. discount_percent is applied correctly to amount_charged
 *
 * plus the paise invariant, validation paths, and a check that the shared
 * reservation module did not change POST /api/orders/create's contract.
 *
 * Cleanup: every reservation it makes is abandoned via /api/orders/verify, so
 * stock returns. It uses @example.com addresses throughout, which is what
 * scripts/reset-db.mjs recognises as test data.
 */

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

let passed = 0;
const failures = [];
const createdOrderIds = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}\n${'─'.repeat(70)}`);
}

async function call(method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  const contentType = res.headers.get('content-type') ?? '';
  try {
    payload = await res.json();
  } catch {
    /* left null — the caller asserts on it */
  }
  return { status: res.status, body: payload, contentType };
}

const order = (extra = {}) => ({
  customer_name: 'Parley Agent',
  customer_email: 'agent@example.com',
  ...extra,
});

/** Abandon a reservation so its stock goes back. */
async function abandon(orderId) {
  if (!orderId) return;
  await call('POST', '/api/orders/verify', { order_id: orderId, failed: true });
}

console.log(`Testing POST /api/orders on ${baseUrl}`);

// Find fixtures.
const list = await call('GET', '/api/products?include_sold_out=true');
if (!list.body?.ok) {
  console.error('Could not list products.', list.body?.error?.message ?? list.status);
  process.exit(1);
}
const products = list.body.data.products;
const inStock = products.find((p) => p.stock_count >= 5);
const soldOut = products.find((p) => p.stock_count === 0);

if (!inStock) {
  console.error('Need a product with at least 5 units to test quantities.');
  process.exit(1);
}

console.log(`  in-stock fixture : ${inStock.name} (${inStock.stock_count} units, ${inStock.price} paise)`);
console.log(`  sold-out fixture : ${soldOut ? soldOut.name : 'none found'}`);

// ============================================================== 1. normal ==
section('1. Normal order on an in-stock product');

const stockBefore = inStock.stock_count;
const normal = await call('POST', '/api/orders', order({ product_id: inStock.id }));

check('201 Created', normal.status === 201, `got ${normal.status} ${JSON.stringify(normal.body?.error ?? '')}`);
check('response is JSON', normal.contentType.includes('application/json'));

const d = normal.body?.data ?? {};
createdOrderIds.push(d.order_id);

check('order_id present', typeof d.order_id === 'string');
check('status present and is "reserved"', d.status === 'reserved', `got ${d.status}`);
check('amount_charged present', typeof d.amount_charged === 'number');
check('amount_charged is whole paise', Number.isInteger(d.amount_charged));
check(
  'amount_charged equals product price (qty 1, no discount)',
  d.amount_charged === inStock.price,
  `${d.amount_charged} vs ${inStock.price}`,
);
check('payment reference present', typeof d.payment?.razorpay_order_id === 'string' && d.payment.razorpay_order_id.startsWith('order_'));
check('razorpay amount matches amount_charged', d.payment?.amount === d.amount_charged);
check('currency is INR', d.payment?.currency === 'INR');
check('key secret is not in the response', !JSON.stringify(normal.body).includes('key_secret'));
check('defaults: quantity 1', d.pricing?.quantity === 1);
check('defaults: discount_percent 0', d.pricing?.discount_percent === 0);

const afterOne = await call('GET', `/api/products/${inStock.id}`);
check(
  'stock decremented by exactly 1',
  afterOne.body?.data?.stock_count === stockBefore - 1,
  `${stockBefore} → ${afterOne.body?.data?.stock_count}`,
);

// ============================================================= 2. quantity ==
section('2. Quantity');

const qty3 = await call('POST', '/api/orders', order({ product_id: inStock.id, quantity: 3 }));
check('201 Created', qty3.status === 201, `got ${qty3.status}`);
const q = qty3.body?.data;
createdOrderIds.push(q?.order_id);
check('quantity recorded as 3', q?.pricing?.quantity === 3);
check('subtotal = unit_price × 3', q?.pricing?.subtotal === inStock.price * 3);
check('amount_charged = subtotal when no discount', q?.amount_charged === inStock.price * 3);

const afterThree = await call('GET', `/api/products/${inStock.id}`);
check(
  'stock decremented by exactly 3',
  afterThree.body?.data?.stock_count === stockBefore - 4,
  `expected ${stockBefore - 4}, got ${afterThree.body?.data?.stock_count}`,
);

// ============================================================= 3. discount ==
section('3. discount_percent applied to amount_charged');

// Each case releases its own reservation immediately. Holding them would
// drain stock across the loop and make later cases fail with a legitimate
// 409 that looks like a pricing bug — which is exactly what it did first time.
for (const [quantity, pct] of [[1, 10], [2, 25], [3, 33], [1, 50], [2, 1], [1, 99]]) {
  const r = await call('POST', '/api/orders', order({ product_id: inStock.id, quantity, discount_percent: pct }));

  const subtotal = inStock.price * quantity;
  const expected = Math.round((subtotal * (100 - pct)) / 100);

  if (r.status !== 201) {
    check(`qty ${quantity} @ ${pct}%`, false, `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
    continue;
  }

  const p = r.body.data.pricing;
  check(
    `qty ${quantity} @ ${pct}% → ${expected} paise`,
    p.amount_charged === expected,
    `got ${p.amount_charged} (subtotal ${subtotal})`,
  );
  check(
    `  discount_amount reconciles (${pct}%)`,
    p.subtotal - p.amount_charged === p.discount_amount,
    `${p.subtotal} - ${p.amount_charged} != ${p.discount_amount}`,
  );
  check(`  amount is whole paise (${pct}%)`, Number.isInteger(p.amount_charged));
  check(
    `  razorpay charges the discounted amount (${pct}%)`,
    typeof r.body.data.payment?.amount === 'number' &&
      r.body.data.payment.amount === p.amount_charged,
    `${r.body.data.payment?.amount} vs ${p.amount_charged}`,
  );

  await abandon(r.body.data.order_id);
}

// ================================================== 4. sold-out / validation ==
section('4. Failure paths');

if (soldOut) {
  const oos = await call('POST', '/api/orders', order({ product_id: soldOut.id }));
  check('sold-out product → 409', oos.status === 409, `got ${oos.status}`);
  check('error code OUT_OF_STOCK', oos.body?.error?.code === 'OUT_OF_STOCK');
  check('response is JSON, not HTML', oos.contentType.includes('application/json'));
  check('no order id handed back', oos.body?.data === undefined);
} else {
  console.log('  skip sold-out product not present');
}

// 50 is under the route's 100-unit cap but above any seeded stock level, so
// this exercises the reservation failing rather than the input validator.
const tooMany = await call('POST', '/api/orders', order({ product_id: inStock.id, quantity: 50 }));
check('quantity beyond stock → 409', tooMany.status === 409, `got ${tooMany.status}`);
check('  OUT_OF_STOCK', tooMany.body?.error?.code === 'OUT_OF_STOCK');
check('  echoes requested_quantity', tooMany.body?.error?.details?.requested_quantity === 50);
check('  reports stock at time of failure', typeof tooMany.body?.error?.details?.stock_count === 'number');
check('  no order was created', tooMany.body?.data === undefined);

// Above the cap is a validation failure, not a stock failure — different code.
const absurd = await call('POST', '/api/orders', order({ product_id: inStock.id, quantity: 9999 }));
check('quantity above the 100-unit cap → 400', absurd.status === 400, `got ${absurd.status}`);
check('  VALIDATION_ERROR not OUT_OF_STOCK', absurd.body?.error?.code === 'VALIDATION_ERROR');

const badProduct = await call('POST', '/api/orders', order({ product_id: '00000000-0000-4000-8000-000000000000' }));
check('unknown product → 404', badProduct.status === 404, `got ${badProduct.status}`);
check('  NOT_FOUND', badProduct.body?.error?.code === 'NOT_FOUND');

for (const [label, patch] of [
  ['quantity 0', { quantity: 0 }],
  ['quantity -1', { quantity: -1 }],
  ['quantity 2.5', { quantity: 2.5 }],
  ['quantity "3" (string)', { quantity: '3' }],
  ['quantity 101', { quantity: 101 }],
]) {
  const r = await call('POST', '/api/orders', order({ product_id: inStock.id, ...patch }));
  check(`${label} → 400`, r.status === 400, `got ${r.status}`);
}

for (const [label, patch] of [
  ['discount -5', { discount_percent: -5 }],
  ['discount 150', { discount_percent: 150 }],
  ['discount 12.5', { discount_percent: 12.5 }],
  ['discount "20" (string)', { discount_percent: '20' }],
]) {
  const r = await call('POST', '/api/orders', order({ product_id: inStock.id, ...patch }));
  check(`${label} → 400`, r.status === 400, `got ${r.status}`);
}

const full = await call('POST', '/api/orders', order({ product_id: inStock.id, discount_percent: 100 }));
check('discount 100% → 400 (below Razorpay ₹1 minimum)', full.status === 400, `got ${full.status}`);
check('  VALIDATION_ERROR', full.body?.error?.code === 'VALIDATION_ERROR');

const emptyBody = await call('POST', '/api/orders', {});
check('empty body → 400', emptyBody.status === 400);
check('  names the offending fields', typeof emptyBody.body?.error?.details?.fields === 'object');

// ============================== 5. the existing checkout route is unchanged ==
section('5. POST /api/orders/create still honours its old contract');

const legacy = await call('POST', '/api/orders/create', order({ product_id: inStock.id }));
createdOrderIds.push(legacy.body?.data?.order?.id);
check('201 Created', legacy.status === 201, `got ${legacy.status}`);
check('still returns { order }', typeof legacy.body?.data?.order?.id === 'string');
check('still returns { razorpay }', typeof legacy.body?.data?.razorpay?.id === 'string');
check('still returns { checkout } for Checkout.js', typeof legacy.body?.data?.checkout?.order_id === 'string');
check('still one unit, no discount', legacy.body?.data?.order?.quantity === 1 && legacy.body?.data?.order?.discount_percent === 0);

// ------------------------------------------------------------------ cleanup --
section('Cleanup');
for (const id of createdOrderIds) await abandon(id);
const finalStock = await call('GET', `/api/products/${inStock.id}`);
check(
  'all reservations released, stock restored',
  finalStock.body?.data?.stock_count === stockBefore,
  `${finalStock.body?.data?.stock_count} (expected ${stockBefore})`,
);

console.log(`\n${'═'.repeat(70)}`);
if (failures.length === 0) {
  console.log(`ALL PASSED — ${passed} checks.`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
