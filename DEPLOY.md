# Deploying Terrain to Vercel

The app is deploy-ready: production build passes, secrets load from env vars
(no files needed), and the DB layer uses Postgres when `DATABASE_URL` is set.

## 1. Database — Supabase (required)

Serverless has no persistent filesystem, so the local JSON store won't work.

1. Create a project at supabase.com (free tier is fine).
2. Project Settings → Database → **Connection string** → **Transaction pooler**
   (port **6543**, not 5432 — the pooler is what works on serverless).
3. Copy that URI; it's your `DATABASE_URL`. Tables auto-create on first request.

## 2. Push to GitHub, then import in Vercel

```bash
# from ~/storepulse — remote + push (create the repo on github.com first)
git remote add origin git@github.com:<you>/terrain.git
git push -u origin main
```

Then at vercel.com → Add New → Project → import the repo. Framework auto-detects
as Next.js. Don't deploy yet — set env vars first (step 3).

(Alternative with no GitHub: run `npx vercel` from `~/storepulse`.)

## 3. Environment variables (Vercel → Settings → Environment Variables)

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Supabase transaction-pooler URI (step 1) |
| `AUTH_SECRET` | run `openssl rand -hex 32` and paste the output |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the **entire contents** of `google-service-account.json`, pasted as one value |
| `TERRAIN_SHEET_ID` | `1U7Iz4INXKsaPLBO5pb46GSRke997wPw8_KI8qFEsl_k` |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → API Keys (use **live** key for real billing) |
| `PAYSTACK_PLAN_STARTER` | from `node scripts/setup-plans.mjs` |
| `PAYSTACK_PLAN_PRO` | from `node scripts/setup-plans.mjs` |
| `NEXT_PUBLIC_SITE_URL` | your real domain, e.g. `https://terrain.co.za` |
| `RESEND_API_KEY` | resend.com → API Keys (for magic-link + digest emails) |
| `EMAIL_FROM` | e.g. `Terrain <hello@terrain.co.za>` (verify the domain in Resend) |

To get the Google value as one line:
```bash
cat google-service-account.json | tr -d '\n'
```

## 4. Deploy, then connect the domain

1. Vercel → Deploy. First build ~1–2 min.
2. Vercel → Settings → Domains → add your domain.
3. At your registrar, add the DNS records Vercel shows (an A record or CNAME).
   SSL is automatic once DNS propagates (minutes to a couple hours).

## 5. Point Paystack's webhook at production

Paystack dashboard → Settings → Webhooks →
`https://<your-domain>/api/webhooks/paystack`

## Post-deploy smoke test

- `/` loads (landing page)
- `/login` → enter email → magic link arrives (Resend) → lands on `/dashboard`
- `/dashboard` shows live leads (proves the Google key env var works)
- Trial pill shows "14 days left"

## Note on the data pipeline

Discovery/enrichment stay where they are (VPS + your Mac writing to the Google
Sheet). Terrain reads that Sheet — deploying the web app doesn't move the
pipeline. Moving leads into Postgres so the app reads the DB directly (instead
of the Sheet) is a later step, not needed to go live.
