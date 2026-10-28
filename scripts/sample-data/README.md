# Sample business for local testing

An invented catering-supplies wholesaler (company `a`): nine months of trading, January to
September 2026 — a general ledger, a bank statement, sales and purchase invoices, a budget and
two balance sheets — plus a campaign that won two customers, Funding Readiness switched on, a
forecast, and a smaller second company (`b`) so the Command Centre has a portfolio. Every name
and figure is made up (`generate.py`); nothing here is customer data.

It is loaded through the app's own screens (the import wizard, the banking page, the forecast
page) by an automated browser signed in as a local account, so loading it also exercises them.

## Load

Everything runs locally, on the Firebase emulators (project `demo-apx`; nothing reaches a real
Firebase project):

1. `scripts/write-local-env.sh` once, so `.env.local` points the app at the emulators.
2. `npm run db:start` — Auth 9099, Firestore 8080, Storage 9199 (data kept in
   `firebase/emulator-data` between runs).
3. The app running on http://127.0.0.1:3000 (`npm run dev`), with the same `CRON_SECRET` as below.
4. A local account signed up in the app, owning the target company, which must be empty (its slug
   defaults to `a-org`; set `MOTION_SAMPLE_SLUG` for another).

```sh
cd scripts/sample-data && python3 generate.py && cd ../..   # (re)writes ./files
MOTION_SAMPLE_EMAIL='you@example.com' MOTION_SAMPLE_PASSWORD='…' CRON_SECRET='…' \
  npx playwright test -c scripts/sample-data/playwright.config.ts 1-seed
```

The run reads ids and counts straight from the Firestore emulator (`firestore.ts`, which refuses
anything but a `demo-` project or an emulator host; it uses `FIREBASE_PROJECT_ID`,
`FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` when set, else the defaults above). The
campaign, its spend, the opportunities and company `b` are written with the app's own functions as
the owner (`call-api.ts`); the Funding Readiness switch and one recalculation job are written
directly, as a platform admin would.

The run is resumable: a file already imported for its type and period is skipped.

## Walk every page

```sh
MOTION_SAMPLE_EMAIL='…' MOTION_SAMPLE_PASSWORD='…' CRON_SECRET='…' \
  npx playwright test -c scripts/sample-data/playwright.config.ts 2-walkthrough
```

Every page of the company and the Command Centre must answer, show no error screen and have no
serious or critical accessibility violation; a screenshot of each lands in
`logs/sample-data/screens`. Then the features are exercised with the sample figures.

The password is read from the environment only; nothing is stored.
