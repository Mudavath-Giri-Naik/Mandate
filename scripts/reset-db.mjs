#!/usr/bin/env node
/**
 * Clear out test data and restore the seeded catalogue.
 *
 *   node scripts/reset-db.mjs              # dry run — shows the plan, changes nothing
 *   node scripts/reset-db.mjs --apply      # do it
 *   node scripts/reset-db.mjs --apply --all --i-understand   # nuke real orders too
 *
 * ── What counts as test data ─────────────────────────────────────────────────
 * An order is TEST only if its customer_email ends in @example.com — the domain
 * RFC 2606 reserves for exactly this, and the only one the scripts in this repo
 * ever use. Everything else is treated as REAL and is never touched without
 * --all --i-understand.
 *
 * Stock is not reset to the raw seed numbers. It is reset to
 *
 *     seeded stock − units consumed by surviving paid orders
 *
 * so a genuine sale keeps its unit deducted. Restoring stock that was really
 * sold would silently oversell the item.
 *
 * ── Why this is so defensive ─────────────────────────────────────────────────
 * The first version of this script ran `DELETE FROM orders` unconditionally and
 * reset stock to the seed values. Run against the shared database while someone
 * was actually shopping, it destroyed three real captured payments and put the
 * sold units back on the shelf. Razorpay still had the payments, so the rows
 * could be rebuilt — but nothing in the database itself would have told you
 * they were ever there. Hence: dry run by default, real orders excluded by
 * default, and stock arithmetic that respects completed sales.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

/** Seeded stock, keyed by the natural identity of each row. */
const SEED = {
  'Heavyweight Cotton Tee|M|White': 24,
  'Heavyweight Cotton Tee|L|Black': 18,
  'Faded Wash Oversized Tee|XL|Olive': 12,
  'Fleece-Back Pullover Hoodie|M|Charcoal': 9,
  'Fleece-Back Pullover Hoodie|L|Navy': 6,
  'Zip-Through Hoodie|XL|Grey': 4,
  'Ribbed Knit Crewneck|S|Cream': 7,
  'Ribbed Knit Crewneck|M|Rust': 5,
  'Washed Denim Trucker Jacket|L|Indigo': 3,
  'Relaxed Chino Trousers|32|Khaki': 11,
  'Relaxed Chino Trousers|34|Black': 8,
  'Cuffed Jogger Sweatpants|M|Charcoal': 14,
  'Striped Long Sleeve Tee|S|Navy': 10,
  'Corduroy Overshirt|L|Tan': 2,
  'Hand-Dyed Indigo Shibori Tee — Last One|M|Indigo': 1,
};

const argv = new Set(process.argv.slice(2));
const APPLY = argv.has('--apply');
const ALL = argv.has('--all');
const ACK = argv.has('--i-understand');

/** RFC 2606 reserves example.com. Our scripts use nothing else. */
const isTestOrder = (o) =>
  typeof o.customer_email === 'string' &&
  o.customer_email.trim().toLowerCase().endsWith('@example.com');

// ------------------------------------------------------------------- config --
function readEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...readEnvLocal(), ...process.env };
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

const rest = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function api(method, p, body, prefer = 'return=representation') {
  const res = await fetch(`${rest}${p}`, {
    method,
    headers: { ...headers, Prefer: prefer },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

// -------------------------------------------------------------------- survey --
const products = await api('GET', '/products?select=id,name,size,color,stock_count,status');
const orders = await api(
  'GET',
  '/orders?select=id,product_id,status,amount,customer_email,razorpay_payment_id,created_at&order=created_at.asc',
);

const testOrders = orders.filter(isTestOrder);
const realOrders = orders.filter((o) => !isTestOrder(o));
const doomed = ALL ? orders : testOrders;
const surviving = orders.filter((o) => !doomed.includes(o));

console.log(`Database : ${SUPABASE_URL}`);
console.log(`Mode     : ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to make changes)'}`);
console.log('');
console.log(`Orders   : ${orders.length} total — ${testOrders.length} test, ${realOrders.length} real`);

if (realOrders.length) {
  console.log('\nReal orders (NOT test data):');
  for (const o of realOrders) {
    const flag = o.razorpay_payment_id ? ` ${o.razorpay_payment_id}` : '';
    const mark = doomed.includes(o) ? '  ← WILL BE DELETED' : '  (keeping)';
    console.log(
      `  ${o.created_at.slice(0, 19)}  ${o.status.padEnd(9)} ${rupees(o.amount).padStart(9)}  ${o.customer_email}${flag}${mark}`,
    );
  }
}

// Units legitimately consumed by paid orders that will still exist afterwards.
const soldByProduct = {};
for (const o of surviving) {
  if (o.status === 'paid' && o.product_id) {
    soldByProduct[o.product_id] = (soldByProduct[o.product_id] ?? 0) + 1;
  }
}

const stockPlan = products
  .map((p) => {
    const seeded = SEED[[p.name, p.size, p.color].join('|')];
    if (seeded === undefined) return null;
    const target = Math.max(0, seeded - (soldByProduct[p.id] ?? 0));
    const status = target === 0 ? 'sold_out' : 'available';
    if (target === p.stock_count && status === p.status) return null;
    return { p, target, status, seeded, sold: soldByProduct[p.id] ?? 0 };
  })
  .filter(Boolean);

if (stockPlan.length) {
  console.log('\nStock changes:');
  for (const { p, target, seeded, sold } of stockPlan) {
    const why = sold ? ` (seed ${seeded} − ${sold} sold)` : '';
    console.log(`  ${p.name} (${p.size}/${p.color}): ${p.stock_count} → ${target}${why}`);
  }
}

console.log('');
if (doomed.length === 0 && stockPlan.length === 0) {
  console.log('Nothing to do — already clean.');
  process.exit(0);
}
console.log(`Plan: delete ${doomed.length} order(s), adjust ${stockPlan.length} product(s).`);

// -------------------------------------------------------------------- guards --
const doomedReal = doomed.filter((o) => !isTestOrder(o));

if (doomedReal.length && !(ALL && ACK)) {
  console.error(
    `\nRefusing: ${doomedReal.length} of those are REAL orders. Pass --all --i-understand.`,
  );
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDry run — nothing changed. Re-run with --apply.');
  process.exit(0);
}

if (doomedReal.length) {
  const paid = doomedReal.filter((o) => o.razorpay_payment_id);
  console.log(
    `\n⚠  About to delete ${doomedReal.length} real order(s), ${paid.length} with a captured Razorpay payment.`,
  );
  console.log('   Razorpay keeps its own record, but this database will not.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question('   Type DELETE to confirm: ')).trim();
  rl.close();
  if (typed !== 'DELETE') {
    console.log('Cancelled.');
    process.exit(0);
  }
}

// --------------------------------------------------------------------- apply --
console.log('');

if (doomed.length) {
  // Delete by explicit id list — never a blanket predicate.
  const ids = doomed.map((o) => o.id);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    await api('DELETE', `/orders?id=in.(${batch.join(',')})`, null, 'return=minimal');
  }
  console.log(`  deleted ${ids.length} order(s)`);
}

for (const { p, target, status } of stockPlan) {
  await api('PATCH', `/products?id=eq.${p.id}`, { stock_count: target, status }, 'return=minimal');
  console.log(`  ${p.name} (${p.size}/${p.color}) → ${target}`);
}

// -------------------------------------------------------------------- verify --
const afterProducts = await api('GET', '/products?select=stock_count');
const afterOrders = await api('GET', '/orders?select=id,status,customer_email');
const total = afterProducts.reduce((a, p) => a + p.stock_count, 0);
const paidLeft = afterOrders.filter((o) => o.status === 'paid').length;

console.log('');
console.log(`Done: ${afterOrders.length} order(s) remain (${paidLeft} paid), ${total} units in stock.`);
if (afterOrders.some((o) => !isTestOrder(o))) {
  console.log('Real orders were preserved.');
}
