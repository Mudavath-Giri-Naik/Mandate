# Deploying to Vercel

Steps you run are marked **you**; the rest I handle. In Claude Code you can prefix a command
with `!` to run it in this session so I see the output directly.

---

## 1. Push to GitHub — **you**

`create-next-app` already ran `git init`, so there is a repo here with no commits yet.

```bash
git add -A
git commit -m "Phase 1 storefront: Next.js + Supabase + Razorpay test mode"
gh repo create mandate-storefront --private --source=. --push
```

If you do not have `gh`, create an empty private repo on github.com and:

```bash
git remote add origin https://github.com/<you>/mandate-storefront.git
git branch -M main
git push -u origin main
```

`.env.local` and `.mcp.json` are gitignored — neither your service-role key nor your Razorpay
secret nor your Supabase access token will be pushed. Worth confirming before you push:

```bash
git status --porcelain | grep -E '\.env\.local|\.mcp\.json'   # must print nothing
```

---

## 2. Import into Vercel — **you**

[vercel.com/new](https://vercel.com/new) → import the repo. Framework detection picks up
Next.js on its own; leave build and output settings at their defaults.

**Before pressing Deploy**, add the environment variables. Expand *Environment Variables* and
add each of these, ticking **Production, Preview and Development** for all of them:

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your `service_role` key |
| `RAZORPAY_KEY_ID` | `rzp_test_…` |
| `RAZORPAY_KEY_SECRET` | your test secret |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | `rzp_test_…` (same as `RAZORPAY_KEY_ID`) |
| `RESERVATION_TTL_MINUTES` | `10` |
| `CRON_SECRET` | a long random string — see below |

Generate the cron secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Vercel sends it to the cron endpoint automatically as `Authorization: Bearer <CRON_SECRET>`.
Once set, `/api/orders/cancel-expired` rejects anyone who doesn't have it.

Press **Deploy**.

---

## 3. Point the app at itself — **you**

After the first deploy you know the URL. Add one more variable and redeploy:

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | `https://your-app.vercel.app` |

The server components can infer their own origin from request headers without this, which is
why the first deploy works. Setting it explicitly removes the guesswork behind Vercel's proxy.

**Settings → Deployments → Redeploy** (untick "use existing build cache").

---

## 4. Check the cron — **you**

**Project → Cron Jobs.** `vercel.json` registers `/api/orders/cancel-expired` at
`*/10 * * * *`.

⚠️ **Hobby plan only allows one cron job, running at most once per day.** If you are on Hobby,
the every-10-minutes schedule will be rejected. Either:

- change `vercel.json` to `"schedule": "0 3 * * *"` (daily at 03:00 UTC), or
- delete the `crons` block and hit the endpoint from an external scheduler
  (cron-job.org, GitHub Actions) every 10 minutes with the bearer token.

Nothing breaks either way — the sweeper is a safety net, and the common case (customer
dismisses the widget) already releases stock instantly via `/api/orders/verify`.

---

## 5. Verify production — **me**

Send me the URL and I run:

```bash
node scripts/smoke-test.mjs https://your-app.vercel.app
node scripts/race-test.mjs  https://your-app.vercel.app 8
```

That covers every route against the live deployment. Then you do the one thing a script
cannot: a real widget payment.

---

## 6. Real payment on production — **you**

1. Open the live site → any product → **Buy Now** → name and email → **Pay**.
2. UPI `success@razorpay`, or card `4111 1111 1111 1111` with any future expiry, any CVV,
   OTP `1234`.
3. You should land on `/order/[id]` reading **paid** with a `pay_…` id.
4. `/admin` should show that order as `paid` and the product's stock down by exactly one.

Then confirm the failure path: buy again, use `failure@razorpay`, and check the order reads
`failed` with the stock returned.

---

## 7. Optional — Razorpay webhook

Makes settlement survive a customer closing their laptop mid-payment.

Razorpay Dashboard (Test Mode) → **Settings → Webhooks → Add New Webhook**:

- **URL:** `https://your-app.vercel.app/api/orders/webhook`
- **Secret:** any long random string
- **Events:** `payment.captured`, `payment.failed`

Add that same string to Vercel as `RAZORPAY_WEBHOOK_SECRET` and redeploy. The endpoint returns
`503 CONFIGURATION_ERROR` until the variable exists, which is a deliberate signal rather than
a silent no-op.

---

## Troubleshooting

**Every API route returns `CONFIGURATION_ERROR`** — an environment variable is missing on
Vercel. The message names which one. Env changes need a redeploy to take effect.

**`/api/orders/create` returns 500 mentioning `reserve_product_stock`** — `supabase/schema.sql`
was not run against the project this deployment points at. Run it in the SQL Editor.

**Checkout button stuck on "Loading payment…"** — `checkout.razorpay.com` did not load. Check
the browser console; usually an ad blocker or a strict content blocker.

**Widget refuses to open, console shows an invalid key** — `NEXT_PUBLIC_RAZORPAY_KEY_ID` is
missing or does not match `RAZORPAY_KEY_ID`. They must be the same value.

**Payment succeeds but the order stays `reserved`** — the browser's verify call did not land.
The confirmation page polls for two minutes; after that the webhook (step 7) is what settles
it. Without a webhook, the sweeper will eventually cancel the order even though the payment
went through — that is exactly the case `409 ORDER_STATE_CONFLICT` is there to flag, and why
the webhook is worth setting up on anything real.
