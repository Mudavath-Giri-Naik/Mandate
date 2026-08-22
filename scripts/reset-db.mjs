#!/usr/bin/env node
/**
 * Restore the database to its freshly-seeded state.
 *
 *   node scripts/reset-db.mjs            # ask before deleting
 *   node scripts/reset-db.mjs --yes      # no prompt
 *
 * Deletes every order and puts each product's stock_count back to the value in
 * supabase/seed.sql. Use it after a testing session, or any time the catalogue
 * has drifted and you want a clean demo.
 *
 * This talks to Supabase directly with the secret key from .env.local, so it
 * works regardless of which deployment you have been testing against — there
 * is one database behind both localhost and Vercel.
 *
 * Equivalent to re-running supabase/setup.sql, minus the schema work.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

// Seeded stock, keyed by the natural identity of each row.
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

// ------------------------------------------------------------------- config --
function readEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...readEnvLocal(), ...process.env };
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Put them in .env.local, or pass them as environment variables.');
  process.exit(1);
}

const rest = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function api(method, pathname, body, prefer = 'return=representation') {
  const res = await fetch(`${rest}${pathname}`, {
    method,
    headers: { ...headers, Prefer: prefer },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// -------------------------------------------------------------------- report --
const products = await api('GET', '/products?select=id,name,size,color,stock_count,status');
const orders = await api('GET', '/orders?select=id,status');

const byStatus = orders.reduce((acc, o) => {
  acc[o.status] = (acc[o.status] ?? 0) + 1;
  return acc;
}, {});

const drift = products
  .map((p) => {
    const want = SEED[[p.name, p.size, p.color].join('|')];
    return want === undefined || want === p.stock_count ? null : { p, want };
  })
  .filter(Boolean);

console.log(`Database: ${SUPABASE_URL}`);
console.log(`  products : ${products.length}`);
console.log(
  `  units    : ${products.reduce((a, p) => a + p.stock_count, 0)} (seeded total 134)`,
);
console.log(
  `  orders   : ${orders.length}${
    orders.length ? ` — ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''
  }`,
);

if (drift.length === 0 && orders.length === 0) {
  console.log('\nAlready at seeded state. Nothing to do.');
  process.exit(0);
}

if (drift.length) {
  console.log('\nStock drift:');
  for (const { p, want } of drift) {
    console.log(
      `  ${p.name} (${p.size}/${p.color}): ${p.stock_count} → ${want}${
        p.status !== 'available' ? `, ${p.status} → available` : ''
      }`,
    );
  }
}

// ------------------------------------------------------------------- confirm --
if (!process.argv.includes('--yes')) {
  console.log(`\nThis DELETES all ${orders.length} order(s) and resets stock.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Continue? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Cancelled.');
    process.exit(0);
  }
}

// --------------------------------------------------------------------- reset --
console.log('');

if (orders.length) {
  // Orders reference products, so they go first.
  await api('DELETE', '/orders?id=not.is.null', null, 'return=minimal');
  console.log(`  deleted ${orders.length} order(s)`);
}

for (const { p, want } of drift) {
  await api(
    'PATCH',
    `/products?id=eq.${p.id}`,
    { stock_count: want, status: 'available' },
    'return=minimal',
  );
  console.log(`  reset ${p.name} (${p.size}/${p.color}) → ${want}`);
}

// ------------------------------------------------------------------- verify --
const after = await api('GET', '/products?select=name,size,color,stock_count,status');
const afterOrders = await api('GET', '/orders?select=id');
const stillWrong = after.filter(
  (p) => SEED[[p.name, p.size, p.color].join('|')] !== p.stock_count,
);
const total = after.reduce((a, p) => a + p.stock_count, 0);

console.log('');
if (stillWrong.length === 0 && afterOrders.length === 0 && total === 134) {
  console.log(`Clean: 15 products, ${total} units, 0 orders.`);
  console.log('The one-unit race item is back in stock.');
} else {
  console.log(`Incomplete — ${total} units, ${afterOrders.length} orders,`);
  console.log(`${stillWrong.length} product(s) still wrong. Re-run supabase/setup.sql.`);
  process.exit(1);
}
