# Mandate — Phase 1 Storefront

A working single-product-checkout clothing store. Next.js 16 (App Router, TypeScript) ·
Supabase Postgres · Razorpay **test mode** · Tailwind v4 · deploys to Vercel.

Every operation exists as a standalone REST route under `/api` — that is the contract the
Phase 2 agent layer will call.

The read queries live in [`src/lib/data.ts`](src/lib/data.ts), and both entry points use them:
the API routes wrap the result in HTTP, the server components render it directly. One
implementation each, so the two cannot drift, and no page depends on being able to reach its
own deployment over the network.

---

## 1. Setup

### 1.1 Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste all of [`supabase/setup.sql`](supabase/setup.sql), run it.
   That is the whole database in one file — tables, constraints, indexes, the atomic stock
   functions, RLS, and 15 seeded products. It ends with a verification query that must print
   **`✅ SETUP OK`**.
3. **Project Settings → API Keys** — copy the Project URL and the **secret** key
   (`sb_secret_…`, or the legacy `service_role` JWT). Not the publishable key.

`supabase/schema.sql` and `supabase/seed.sql` are the same content split in two, if you ever
want to reseed the catalogue without touching the schema.

The schema is not just tables. It defines three SQL functions that the API routes call:

| Function | Purpose |
| --- | --- |
| `reserve_product_stock(uuid)` | Single conditional `UPDATE … WHERE stock_count > 0 RETURNING *`. Zero rows back = out of stock. |
| `release_product_stock(uuid)` | Puts one unit back after a failed or abandoned payment. |
| `cancel_expired_orders(int)` | Sweeps abandoned reservations and credits their stock, in one transaction. |

If you skip `schema.sql`, `/api/orders/create` returns a 500 that says so explicitly.

### 1.2 Razorpay

1. Sign in at [dashboard.razorpay.com](https://dashboard.razorpay.com) and switch the toggle to **Test Mode**.
2. **Settings → API Keys → Generate Test Key**. The key id must begin with `rzp_test_`.
3. Copy both the key id and the secret — the secret is shown only once.

### 1.3 Environment

```bash
cp .env.example .env.local
```

Fill it in:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...          # server only
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
RAZORPAY_KEY_SECRET=your_test_secret       # server only
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_xxxxxxxx   # same id, browser-safe
RESERVATION_TTL_MINUTES=10
```

`SUPABASE_SERVICE_ROLE_KEY` and `RAZORPAY_KEY_SECRET` are read only from server modules
(`src/lib/supabase.ts`, `src/lib/razorpay.ts`) and never reach the client bundle. Only
`NEXT_PUBLIC_RAZORPAY_KEY_ID` is sent to the browser, which is what Checkout.js needs.

### 1.4 Run

```bash
npm install
npm run dev          # http://localhost:3000
```

---

## 2. Pages

| Route | What it does |
| --- | --- |
| `/` | Product grid, filters by size / colour / max price |
| `/product/[id]` | Full detail, live stock, Buy Now |
| `/checkout?product_id=…` | Name + email, total, opens the Razorpay widget |
| `/order/[id]` | Confirmation. Polls `GET /api/orders/:id` every 3s until settled |
| `/admin` | Every product with stock, every order with status, plus a manual sweep button |

---

## 3. API

Every response uses one envelope:

```jsonc
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "OUT_OF_STOCK", "message": "…" } }
```

Error codes: `VALIDATION_ERROR` · `NOT_FOUND` · `OUT_OF_STOCK` · `INVALID_SIGNATURE` ·
`ORDER_STATE_CONFLICT` · `UNAUTHORIZED` · `PAYMENT_GATEWAY_ERROR` · `CONFIGURATION_ERROR` ·
`INTERNAL_ERROR`.

**Money is in paise everywhere** — database, API, Razorpay. ₹499 is `49900`. Rupees appear
only at render time.

### `GET /api/products`

Products with `stock_count > 0`. Query params: `?size=` `?color=` (both case-insensitive
exact) `?max_price=` (paise, inclusive) `?include_sold_out=true`.

### `GET /api/products/:id`

One product plus a live `stock_count` and an `in_stock` boolean.
`404` unknown id · `400` malformed id.

### `POST /api/orders/create`

```json
{ "product_id": "uuid", "customer_name": "Asha Menon", "customer_email": "asha@example.com" }
```

1. **Reserves stock atomically** via `reserve_product_stock()` — one conditional UPDATE
   inside Postgres, before any order row exists and before Razorpay is contacted. Zero rows
   back → `409 OUT_OF_STOCK`, and no order is created.
2. Inserts an `orders` row with `status = 'reserved'`.
3. Creates the Razorpay order (test mode).
4. Returns the order, the Razorpay order, and a ready-to-use `checkout` block.

Every step after the reservation is compensated on failure — if the insert fails or Razorpay
rejects us, the unit goes straight back.

`201` created · `400` validation · `404` unknown product · `409` out of stock ·
`502` Razorpay unreachable.

### `POST /api/orders/verify`

```json
{ "order_id": "uuid", "razorpay_order_id": "order_…", "razorpay_payment_id": "pay_…", "razorpay_signature": "…" }
```

or `{ "order_id": "uuid", "failed": true }` when the customer dismisses the widget.

Recomputes `HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)` and
compares it with `timingSafeEqual`. **The frontend's claim that payment succeeded is never
trusted.** Valid → `paid` and the payment id is stored. Invalid or abandoned → `failed` and
the stock is released.

Idempotent in both directions: every transition is a conditional update guarded on
`status = 'reserved'`, so replaying this endpoint can never release the same unit twice.

`200` settled · `400` invalid signature · `404` unknown order ·
`409` order left `reserved` while verifying (its reservation expired — refund manually).

### `POST /api/orders/cancel-expired` and `GET` (Vercel Cron)

Releases stock from orders stuck in `reserved` past `RESERVATION_TTL_MINUTES`.
`GET` is the verb schedulers use; `POST` accepts `{ "minutes": 0 }` so you can expire
everything immediately while testing.

Two schedules call it, because Vercel's Hobby plan allows only one cron per day:
[`vercel.json`](vercel.json) runs it daily at 03:00 UTC, and
[`.github/workflows/sweep-expired-reservations.yml`](.github/workflows/sweep-expired-reservations.yml)
runs it every 10 minutes for free. See [`DEPLOY.md`](DEPLOY.md) §4.

Guarded by `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set; open when it isn't,
so Postman works locally.

### `GET /api/orders/:id`

Order plus its product, with `is_settled` and `is_paid` convenience flags for polling.

### `GET /api/admin/overview`

Products, orders and aggregate stats in one round trip. **No auth** — testing only.

### `POST /api/orders/webhook` *(optional)*

Razorpay server-to-server backstop for `payment.captured` / `payment.failed`, so a customer
who closes their laptop mid-payment still settles. Needs `RAZORPAY_WEBHOOK_SECRET`. Everything
works without it.

---

## 4. Testing

### 4.1 Automated

```bash
npm run dev          # leave running in one terminal

npm run test:smoke   # ~45 checks across every route
npm run test:race    # 5 concurrent buyers, one unit of stock
```

`test:smoke` covers listing, filtering, validation, 404/400 paths, reservation, stock
decrement, forged-signature rejection, **genuine-signature acceptance** (it computes a real
HMAC from your key secret, which is exactly what Razorpay sends — so the paid path is
exercised without the widget), verify idempotency, the sweeper, and double-sweep safety.

It releases every reservation it makes, with one deliberate exception: the order it genuinely
pays for keeps its unit deducted, because that is a completed sale. The summary names that
product and prints the SQL to restock it.

`test:race` fires N simultaneous `POST /api/orders/create` at the seeded one-unit product and
fails loudly unless exactly one gets `201`, every other gets `409`, and stock settles at `0`.

```bash
node scripts/race-test.mjs http://localhost:3000 10   # crank up concurrency
```

### 4.2 Postman

Import [`postman/Mandate.postman_collection.json`](postman/Mandate.postman_collection.json).
Set the `baseUrl` collection variable, then run **Products → List products** first — its test
script captures `product_id` and `single_stock_product_id` into collection variables that the
later requests use. **Orders → Create order** captures `order_id` and `razorpay_order_id`.

Every request carries assertions, so **Run collection** works as a regression suite.

**The two-tab race, by hand:** send *Create order — LAST UNIT* twice. First send → `201`.
Second → `409 OUT_OF_STOCK` with no second order created. Confirm on `/admin` that the
product reads `0` and `sold_out`, and that there is exactly one order.

### 4.3 A real test-mode payment

1. Open any product → **Buy Now** → fill in name and email → **Pay**.
2. In the Razorpay widget use test credentials:
   - **UPI success:** `success@razorpay`
   - **UPI failure:** `failure@razorpay`
   - **Card:** `4111 1111 1111 1111`, any future expiry, any CVV, OTP `1234`
3. On success you land on `/order/[id]` showing **paid**, with the payment id.
4. Check `/admin`: the order is `paid` and the product's stock has dropped by exactly one.

Also worth trying:

- **Abandon a payment** — close the widget. The order goes to `failed` and stock returns
  immediately (the `ondismiss` handler fires `verify` with `failed: true`).
- **Expiry sweep** — start a checkout, close the tab entirely without dismissing, then press
  **Expire reservations now** on `/admin`. The order flips to `cancelled` and stock returns.

### 4.4 Resetting

```bash
npm run db:reset          # prompts first
node scripts/reset-db.mjs --yes
```

Deletes every order and puts each product's stock back to its seeded value, reporting the
drift before it acts. Idempotent — running it on a clean database does nothing. It talks to
Supabase directly, so it does not matter whether you were testing localhost or production;
there is one database behind both.

Re-running [`supabase/setup.sql`](supabase/setup.sql) does the same thing and rebuilds the
schema as well.

---

## 5. Deploying to Vercel

```bash
git init && git add -A && git commit -m "Phase 1 storefront"
gh repo create mandate-storefront --private --source=. --push
```

Then [vercel.com/new](https://vercel.com/new) → import the repo → add every variable from
`.env.example` under **Settings → Environment Variables** (Production, Preview and
Development) → **Deploy**.

Afterwards:

- Set `CRON_SECRET` to a long random string. Vercel Cron sends it automatically as a bearer
  token, and `/api/orders/cancel-expired` will start rejecting unauthenticated calls.
- Check **Settings → Deployment Protection**. Vercel Authentication is on by default and
  answers API clients with an HTML login page, so Postman and the sweeper will fail against
  production until you disable it or use a bypass token. See [`DEPLOY.md`](DEPLOY.md) §3.
- Verify the cron under **Project → Cron Jobs**. `vercel.json` already registers
  `/api/orders/cancel-expired` at `*/10 * * * *`. Hobby-plan projects are limited to daily
  crons — on Hobby, change the schedule to `0 3 * * *` or call the endpoint from an external
  scheduler.
- Smoke-test production directly:

  ```bash
  node scripts/smoke-test.mjs https://your-app.vercel.app
  ```

---

## 6. How the race condition is actually prevented

The reservation is never a read-then-write. It is one statement:

```sql
update products
   set stock_count = stock_count - 1,
       status = case when stock_count - 1 = 0 then 'sold_out' else status end
 where id = :product_id
   and stock_count > 0
returning *;
```

Two requests for the last unit both reach this statement. Postgres takes a row lock; the
first decrements 1 → 0 and returns a row. The second then re-evaluates its `WHERE` clause
against the committed value, finds `stock_count > 0` false, and returns **zero rows**. The
route reads that as out of stock and returns `409` without creating an order.

A `check (stock_count >= 0)` constraint on the table is the belt to that braces — even a
future bug cannot push stock negative; it would abort the transaction instead.

The `orders.status` column does the same job for payment settlement. Both `/api/orders/verify`
and the webhook write with `.eq('status', 'reserved')`, and only the call whose update
actually matched a row releases stock. Duplicate callbacks, a webhook racing the browser, and
the sweeper racing a slow payment all resolve to a single state transition.

---

## 7. Layout

```
src/
  app/
    page.tsx                       product grid + filters
    product/[id]/page.tsx          detail + Buy Now
    checkout/page.tsx              server shell
    checkout/checkout-form.tsx     client: create → Razorpay widget → verify
    order/[id]/page.tsx            server shell
    order/[id]/order-status-view.tsx   client: polls until settled
    admin/page.tsx                 stock + orders tables
    admin/sweep-button.tsx         manual expiry trigger
    api/
      products/route.ts            GET list + filters
      products/[id]/route.ts       GET one
      orders/create/route.ts       POST reserve + razorpay order
      orders/verify/route.ts       POST HMAC verification
      orders/cancel-expired/route.ts   GET (cron) + POST (manual)
      orders/[id]/route.ts         GET status
      orders/webhook/route.ts      POST razorpay events
      admin/overview/route.ts      GET dashboard data
  lib/
    data.ts       shared read layer — routes and pages both call this
    supabase.ts   service-role client (server only)
    razorpay.ts   SDK + HMAC verification (server only)
    api.ts        response envelope, error wrapper, validators
    env.ts        env access with clear failure messages
    money.ts      paise → ₹ formatting
    types.ts      Product, Order, statuses
supabase/schema.sql   tables, constraints, RLS, the three stock functions
supabase/seed.sql     15 products, one with stock_count = 1
scripts/smoke-test.mjs
scripts/race-test.mjs
scripts/reset-db.mjs
postman/Mandate.postman_collection.json
```

---

## 8. Not in this phase

No AI agents, MCP server or LangGraph. No customer auth. No multi-item cart — checkout is one
product at a time, by design.
