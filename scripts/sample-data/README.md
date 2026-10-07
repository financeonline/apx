# Sample business for local testing

An invented catering-supplies wholesaler (company `a`): nine months of trading, January to
September 2026 — a general ledger, a bank statement, sales and purchase invoices, a budget and
two balance sheets — plus a campaign that won two customers, Funding Readiness switched on, a
forecast, and a smaller second company (`b`) so the Command Centre has a portfolio. Every name
and figure is made up (`generate.py`); nothing here is customer data.

It is loaded through the app's own screens (the import wizard, the banking page, the forecast
page) by an automated browser signed in as a local account, so loading it also exercises them.

## Load

The app must be running on http://127.0.0.1:3000 with its job runner, and the target company must
exist and be empty (its slug defaults to `a-org`).

```sh
cd scripts/sample-data && python3 generate.py && cd ../..   # (re)writes ./files
MOTION_SAMPLE_EMAIL='you@example.com' MOTION_SAMPLE_PASSWORD='…' CRON_SECRET='…' \
  npx playwright test -c scripts/sample-data/playwright.config.ts 1-seed
```

The run is resumable: a file already imported for its type and period is skipped.

## Walk every page

```sh
MOTION_SAMPLE_EMAIL='…' MOTION_SAMPLE_PASSWORD='…' CRON_SECRET='…' \
  npx playwright test -c scripts/sample-data/playwright.config.ts 2-walkthrough
```

Every page of the company and the Command Centre must answer, show no error screen and have no
serious or critical accessibility violation; a screenshot of each lands in
`logs/sample-data/screens`. Then the features are exercised with the sample figures.

## Arrange Home's cards

```sh
MOTION_SAMPLE_EMAIL='…' MOTION_SAMPLE_PASSWORD='…' \
  npx playwright test -c scripts/sample-data/playwright.config.ts 3-arrange
```

Moves a headline card with the keyboard and the mouse, checks the order survives a reload and that
"Reset order" restores it (ADR-152).

The password is read from the environment only; nothing is stored.
