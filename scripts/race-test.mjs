#!/usr/bin/env node
/**
 * Concurrency check for the stock reservation.
 *
 *   node scripts/race-test.mjs [baseUrl] [concurrency]
 *   node scripts/race-test.mjs http://localhost:3000 8
 *
 * Finds the seeded stock_count = 1 product, then fires N simultaneous
 * /api/orders/create requests at it. Exactly one must get 201; every other
 * one must get a clean 409 OUT_OF_STOCK. Anything else — a 500, two 201s, or
 * negative stock afterwards — is a real bug and the script exits non-zero.
 */

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const concurrency = Number(process.argv[3] ?? 5);

const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

function line() {
  console.log('─'.repeat(66));
}

const listRes = await fetch(`${baseUrl}/api/products?include_sold_out=true`);
const list = await json(listRes);

if (!list?.ok) {
  console.error(`Could not list products from ${baseUrl}.`);
  console.error(list?.error?.message ?? `HTTP ${listRes.status}`);
  process.exit(1);
}

const target = list.data.products.find((p) => p.stock_count === 1);

if (!target) {
  console.error('No product with stock_count = 1 to test against.');
  console.error('Re-run supabase/seed.sql, or set one product to stock_count = 1:');
  console.error("  update products set stock_count = 1, status = 'available' where name ilike '%Shibori%';");
  process.exit(1);
}

line();
console.log(`Target : ${target.name}`);
console.log(`Id     : ${target.id}`);
console.log(`Stock  : ${target.stock_count}`);
console.log(`Firing : ${concurrency} simultaneous POST /api/orders/create`);
line();

const attempts = await Promise.all(
  Array.from({ length: concurrency }, async (_, i) => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: target.id,
        customer_name: `Racer ${i + 1}`,
        customer_email: `racer${i + 1}@example.com`,
      }),
    });
    return { i: i + 1, status: res.status, body: await json(res) };
  }),
);

for (const a of attempts.sort((x, y) => x.i - y.i)) {
  const code = a.body?.ok ? 'CREATED' : (a.body?.error?.code ?? 'UNKNOWN');
  const detail = a.body?.ok ? a.body.data.order.id : (a.body?.error?.message ?? '');
  console.log(`  #${String(a.i).padStart(2)}  ${a.status}  ${code.padEnd(18)} ${detail}`);
}

const created = attempts.filter((a) => a.status === 201);
const conflicts = attempts.filter((a) => a.status === 409);
const other = attempts.filter((a) => a.status !== 201 && a.status !== 409);

const after = await json(await fetch(`${baseUrl}/api/products/${target.id}`));
const finalStock = after?.ok ? after.data.stock_count : null;

line();
console.log(`201 Created      : ${created.length}   (expected 1)`);
console.log(`409 Out of stock : ${conflicts.length}   (expected ${concurrency - 1})`);
console.log(`Other responses  : ${other.length}   (expected 0)`);
console.log(`Stock afterwards : ${finalStock}   (expected 0)`);
console.log(`Product status   : ${after?.ok ? after.data.status : 'unknown'}   (expected sold_out)`);
line();

const failures = [];
if (created.length !== 1) failures.push(`${created.length} orders were created — the item was oversold or nobody won.`);
if (other.length !== 0) failures.push(`${other.length} request(s) failed with an unexpected status.`);
if (finalStock !== 0) failures.push(`Stock settled at ${finalStock} instead of 0.`);

if (failures.length > 0) {
  console.log('FAILED');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}

console.log('PASSED — exactly one buyer won, the rest got a clean 409, stock is 0.');
console.log('');
console.log('Reset for another run:');
console.log(`  update products set stock_count = 1, status = 'available' where id = '${target.id}';`);
