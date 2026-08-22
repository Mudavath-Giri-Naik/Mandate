# Deploying to Vercel

Steps you run are marked **you**; the rest I handle. In Claude Code you can prefix a command
with `!` to run it in this session so I see the output directly.

---

## 1. GitHub — done

The repo is live at **https://github.com/Mudavath-Giri-Naik/Mandate** on `main`.

`.env.local` and `.mcp.json` are gitignored, so no Supabase secret key, Razorpay secret, or
access token is in the history. To re-check after any future commit:

```bash
git log --all -S'sb_secret_sL' --oneline    # must print nothing
git log --all -S'RAZORPAY_KEY_SECRET=' --oneline
```

To push later work:

```bash
git add -A
git commit -m "…"
git push
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

## 4. The expiry sweeper

Two schedules run the same endpoint, because Vercel's Hobby plan caps cron jobs at **one per
day** — it rejects anything more frequent with:

> Hobby accounts are limited to daily cron jobs.

**Vercel (daily).** `vercel.json` is set to `0 3 * * *` — 03:00 UTC, which Hobby accepts.
Check it under **Project → Cron Jobs** after deploying. On a Pro plan you can change this back
to `*/10 * * * *` and skip the rest of this section.

**GitHub Actions (every 10 minutes).** `.github/workflows/sweep-expired-reservations.yml`
calls the same endpoint on a `*/10` schedule, free on any plan. To switch it on:

**Repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `APP_URL` | `https://your-app.vercel.app` (no trailing slash) |
| `CRON_SECRET` | the same value you set in Vercel |

Until both exist the job exits cleanly with a note instead of failing, so a fresh clone does
not show a red X. You can trigger it by hand any time from the **Actions** tab
(*Sweep expired reservations* → *Run workflow*) — useful for confirming the secrets are right
without waiting for the schedule.

GitHub's scheduler is best-effort: a `*/10` job can slip by several minutes under load, and
schedules pause on repos with no activity for 60 days. That is acceptable here.

**Why a daily sweep is not actually a disaster.** The sweeper only catches stragglers. When a
customer dismisses the Razorpay widget, the browser immediately calls `/api/orders/verify`
with `{ failed: true }` and the unit goes back within the same second. The sweeper exists for
the cases the browser cannot report — a closed laptop, a dropped connection, a killed tab.
Those are rare, and on Hobby-without-Actions they would hold stock for up to 24 hours.

If you would rather not use GitHub Actions, any external scheduler works — point
[cron-job.org](https://cron-job.org) at `GET /api/orders/cancel-expired` with the
`Authorization: Bearer <CRON_SECRET>` header.

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
