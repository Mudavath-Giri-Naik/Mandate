#!/usr/bin/env node
/**
 * Concurrency check for POST /api/orders, the agent endpoint.
 *
 *   node scripts/race-test-agent.mjs [baseUrl] [concurrency]
 *
 * Runs three rounds against a product that has exactly ONE unit:
 *
 *   A  N simultaneous POST /api/orders
 *   B  N simultaneous POST /api/orders/create      (the storefront route)
 *   C  N/2 of each, interleaved
 *
 * Round C is the one that matters. Both routes call the same
 * reserveAndCreateOrder(), which reserves through the same conditional UPDATE
 * in Postgres, so a browser buyer and an agent buyer must contend correctly
 * with each other — not just with their own kind. If the lock were per-route,
 * C would oversell while A and B looked fine.
 *
 * Every round must end with exactly one 201, the rest 409 OUT_OF_STOCK, and
 * stock at 0. Anything else exits non-zero.
 */

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const concurrency = Number(process.argv[3] ?? 6);

const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const line = (c = '─') => console.log(c.repeat(72));

async function get(route) {
  return json(await fetch(`${baseUrl}${route}`));
}

async function post(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res) };
}

/** Put the fixture back to exactly one available unit, and clear its orders. */
async function resetToOneUnit(productId, orderIds) {
  for (const id of orderIds) {
    if (id) await post('/api/orders/verify', { order_id: id, failed: true });
  }
  const p = await get(`/api/products/${productId}`);
  return p?.data?.stock_count ?? null;
}

const list = await get('/api/products?include_sold_out=true');
if (!list?.ok) {
  console.error('Could not list products.');
  process.exit(1);
}

const target = list.data.products.find((p) => p.stock_count === 1);
if (!target) {
  console.error('No product with stock_count = 1.');
  console.error('Set one up first:');
  console.error("  update products set stock_count = 1, status = 'available' where name ilike '%Shibori%';");
  process.exit(1);
}

line('═');
console.log(`Target      : ${target.name}`);
console.log(`Id          : ${target.id}`);
console.log(`Price       : ${target.price} paise`);
console.log(`Concurrency : ${concurrency} per round`);
line('═');

const rounds = [
  {
    name: 'A — POST /api/orders only (agent route)',
    build: (i) => ({
      route: '/api/orders',
      body: {
        product_id: target.id,
        customer_name: `Agent ${i}`,
        customer_email: `agent${i}@example.com`,
        quantity: 1,
      },
    }),
  },
  {
    name: 'B — POST /api/orders/create only (storefront route)',
    build: (i) => ({
      route: '/api/orders/create',
      body: {
        product_id: target.id,
        customer_name: `Shopper ${i}`,
        customer_email: `shopper${i}@example.com`,
      },
    }),
  },
  {
    name: 'C — both routes interleaved (the real test)',
    build: (i) =>
      i % 2 === 0
        ? {
            route: '/api/orders',
            body: {
              product_id: target.id,
              customer_name: `Agent ${i}`,
              customer_email: `agent${i}@example.com`,
              quantity: 1,
            },
          }
        : {
            route: '/api/orders/create',
            body: {
              product_id: target.id,
              customer_name: `Shopper ${i}`,
              customer_email: `shopper${i}@example.com`,
            },
          },
  },
];

let anyFailure = false;

for (const round of rounds) {
  console.log(`\n${round.name}`);
  line();

  const attempts = await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const { route, body } = round.build(i + 1);
      const r = await post(route, body);
      return { i: i + 1, route, ...r };
    }),
  );

  const orderIds = [];
  for (const a of attempts.sort((x, y) => x.i - y.i)) {
    const isWin = a.status === 201;
    // The two routes nest the order id differently.
    const id = isWin ? (a.body?.data?.order_id ?? a.body?.data?.order?.id) : null;
    if (id) orderIds.push(id);
    const code = isWin ? 'CREATED' : (a.body?.error?.code ?? 'UNKNOWN');
    console.log(
      `  #${String(a.i).padStart(2)}  ${a.status}  ${code.padEnd(14)} ${a.route.padEnd(20)} ${id ?? ''}`,
    );
  }

  const created = attempts.filter((a) => a.status === 201).length;
  const conflicts = attempts.filter((a) => a.status === 409).length;
  const other = attempts.filter((a) => a.status !== 201 && a.status !== 409);

  const after = await get(`/api/products/${target.id}`);
  const stock = after?.ok ? after.data.stock_count : null;
  const status = after?.ok ? after.data.status : '?';

  const problems = [];
  if (created !== 1) problems.push(`${created} orders created, expected exactly 1`);
  if (other.length) problems.push(`${other.length} unexpected status code(s)`);
  if (stock !== 0) problems.push(`stock is ${stock}, expected 0`);
  if (status !== 'sold_out') problems.push(`status is ${status}, expected sold_out`);

  console.log(
    `  → 201:${created}  409:${conflicts}  other:${other.length}  stock:${stock}  status:${status}  ` +
      (problems.length ? 'FAIL' : 'PASS'),
  );
  for (const p of problems) console.log(`     • ${p}`);
  if (problems.length) anyFailure = true;

  // Put the single unit back for the next round.
  const restored = await resetToOneUnit(target.id, orderIds);
  if (restored !== 1) {
    console.log(`     • could not restore fixture to 1 unit (now ${restored})`);
    anyFailure = true;
    break;
  }
}

console.log('');
line('═');
if (anyFailure) {
  console.log('FAILED — see the rounds above.');
  process.exit(1);
}
console.log('PASSED — all rounds: exactly one winner, everyone else a clean 409.');
console.log('Both routes contend on the same Postgres row lock, as intended.');
line('═');
