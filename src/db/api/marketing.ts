import 'server-only';
import { arg, type DbFunctions } from '../registry';
import { raise } from '../raise';
import { globalRow, newId, nowIso, ORG_SINGLETON_ID, orgCollection, orgRow } from '../schema';
import { runTx } from '../tx';
import { readerOf, uidOf, type Db } from '../types';
import { requirePermission } from '../app/access';
import { aiTokensUsedThisMonth, effectiveQuota } from '../app/ai-quota';
import { prepareAudit } from '../app/audit';
import { jobRef, prepareEnqueue } from '../app/jobs';
import { throttle } from '../app/throttle';
import {
  btrim, charLength, jsonEqual, prepareRowAudit, readOrganization, rpcThrottle, textOf,
} from '../app/financials-helpers';
import {
  REPORT_NOT_FINISHED, companyProfileReady, marketingEnabled, marketingInFlightGuard,
} from '../app/marketing-reports';

/**
 * `api.*` functions of Marketing (ADR-170), ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8): the
 * company profile the report is written about, and asking for the report — which creates the
 * attempt and its `marketing.generate` job in one transaction, one attempt in flight per
 * organisation (`marketing_reports_one_in_flight`, a guard document).
 */

const WEB_ADDRESS = /^https?:\/\/[^\s/?#]+[^\s]*$/i;
const nullIfBlank = (v: unknown): string | null => {
  const t = btrim(typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  return t === '' ? null : t;
};

/**
 * `api.set_company_profile(p_org, p_website, p_social_links, p_products_services, p_industry,
 * p_description)` → p_org. The whole profile is replaced; its industry is `organizations.industry`.
 */
async function set_company_profile(db: Db, args: Record<string, unknown>): Promise<string> {
  await rpcThrottle(db);
  const org = arg.str(args, 'p_org');
  await requirePermission(db, org, 'customers.edit');
  const orgId = org!;
  const website = nullIfBlank(args.p_website);
  const products = nullIfBlank(args.p_products_services);
  const industry = nullIfBlank(args.p_industry);
  const description = nullIfBlank(args.p_description);

  if (website !== null && (charLength(website) > 500 || !WEB_ADDRESS.test(website))) {
    raise.invalid('the website must be a web address starting http:// or https://');
  }
  if (products !== null && charLength(products) > 2000) raise.invalid('products and services must be 2,000 characters or fewer');
  if (industry !== null && charLength(industry) > 120) raise.invalid('the industry must be 120 characters or fewer');
  if (description !== null && charLength(description) > 4000) raise.invalid('the description must be 4,000 characters or fewer');

  const links: Array<{ label: string; url: string }> = [];
  const given = args.p_social_links;
  if (given !== null && given !== undefined) {
    if (!Array.isArray(given)) raise.invalid('social links must be a list');
    if (given.length > 12) raise.invalid('add at most 12 social links');
    for (const link of given as unknown[]) {
      if (link === null || typeof link !== 'object' || Array.isArray(link)) {
        raise.invalid('each social link needs a name and an address');
      }
      const label = nullIfBlank(textOf(link as Record<string, unknown>, 'label'));
      const url = nullIfBlank(textOf(link as Record<string, unknown>, 'url'));
      if (label === null || charLength(label) > 60) raise.invalid('each social link needs a name of 60 characters or fewer');
      if (url === null || charLength(url) > 500 || !WEB_ADDRESS.test(url)) {
        raise.invalid(`the ${label} link must be a web address starting http:// or https://`);
      }
      links.push({ label, url });
    }
  }

  return runTx(db, async (tx) => {
    const organization = await readOrganization(db.fs, orgId, readerOf(tx));
    const profileRef = orgRow(db.fs, orgId, 'organization_profiles', ORG_SINGLETON_ID);
    const profile = await tx.get(profileRef);
    const p = profile.exists ? profile.data()! : null;
    const before = {
      website: p ? p.website ?? null : null,
      social_links: p ? p.social_links ?? null : null,
      products_services: p ? p.products_services ?? null : null,
      description: p ? p.description ?? null : null,
      industry: organization.industry ?? null,
    };
    const after = { website, social_links: links, products_services: products, description, industry };
    const now = nowIso();
    const industryChanged = (organization.industry ?? null) !== industry;
    const orgAudit = industryChanged
      ? await prepareRowAudit(db, 'organizations', 'update', organization, { ...organization, industry, updated_at: now }, tx)
      : null;
    const event = jsonEqual(before, after) ? null : await prepareAudit(db, {
      organizationId: orgId, action: 'company_profile.updated', targetTable: 'organization_profiles', targetId: orgId,
      before, after,
    }, tx);

    const fields = { website, social_links: links, products_services: products, description, updated_by: uidOf(db), updated_at: now };
    if (p) tx.update(profileRef, fields);
    else tx.set(profileRef, { organization_id: orgId, ...fields, created_at: now });
    if (industryChanged) {
      tx.update(globalRow(db.fs, 'organizations', orgId), { industry, updated_at: now });
      orgAudit!.write(tx);
    }
    event?.write(tx);
    return orgId;
  });
}

/**
 * `api.request_marketing_report(p_org)` → `{report_id, created}`. One at a time: a second press
 * returns the attempt already under way and spends nothing; otherwise the profile must be ready,
 * the month's AI allowance unspent (CD-24), and at most three reports an hour per organisation.
 */
async function request_marketing_report(db: Db, args: Record<string, unknown>): Promise<{ report_id: string; created: boolean }> {
  await rpcThrottle(db);
  const org = arg.str(args, 'p_org');
  await requirePermission(db, org, 'reports.generate');
  await requirePermission(db, org, 'ai.use');
  const orgId = org!;
  // A switched-off system is absent, not refused (ADR-158).
  if (!(await marketingEnabled(db.fs, orgId))) raise.notFound();

  // An attempt whose job has ended cannot hold the slot (the job's end normally sees to this; this
  // covers a job row that is gone).
  const underWay = await runTx(db, async (tx) => {
    const open = await tx.get(orgCollection(db.fs, orgId, 'marketing_reports').where('status', 'in', ['queued', 'running']));
    const jobs = await Promise.all(open.docs.map((d) => {
      const job = d.get('job_id') as string | null | undefined;
      return job ? tx.get(jobRef(db.fs, job)) : Promise.resolve(null);
    }));
    const guard = open.size > 0 ? await marketingInFlightGuard(db.fs, orgId).read(tx) : null;
    const live = (i: number) => {
      const job = jobs[i];
      return Boolean(job?.exists && ['queued', 'running', 'deferred_upstream'].includes(String(job.get('status'))));
    };
    const now = nowIso();
    let current: string | null = null;
    open.docs.forEach((d, i) => {
      if (live(i)) { current ??= d.id; return; }
      tx.update(d.ref, { status: 'failed', failure: REPORT_NOT_FINISHED, finished_at: now, updated_at: now });
      if (guard && guard.owner === d.id) guard.release(tx);
    });
    return current;
  });
  if (underWay !== null) return { report_id: underWay, created: false };

  if (!(await companyProfileReady(db.fs, orgId))) {
    raise.invalid('add what the company sells, or its industry, to the company profile first');
  }
  // The same monthly ceiling the analyst and the PDF reader are held to (CD-24).
  const ceiling = await effectiveQuota(db.fs, orgId, 'ai_token_ceiling_monthly');
  if (ceiling !== null && (await aiTokensUsedThisMonth(db.fs, orgId)) >= ceiling) {
    raise.quota('this company\'s AI allowance for the month has been used');
  }
  // Three reports an hour per organisation. Counted here, after every refusal above, so a refused or
  // repeated press costs nothing.
  await throttle(db.fs, orgId, 'marketing_report', 3, 3600);

  return runTx(db, async (tx) => {
    const once = marketingInFlightGuard(db.fs, orgId);
    const claim = await once.read(tx);
    if (claim.owner) {
      const held = await tx.get(orgRow(db.fs, orgId, 'marketing_reports', claim.owner));
      if (held.exists && ['queued', 'running'].includes(String(held.get('status')))) {
        return { report_id: claim.owner, created: false };
      }
    }
    const id = newId();
    const actor = uidOf(db);
    // One attempt: each is a paid model call, and a failure is the person's to retry, not the queue's.
    const job = await prepareEnqueue(db.fs, {
      organizationId: orgId, jobType: 'marketing.generate', payload: { reportId: id }, requestedBy: actor,
      idempotencyKey: `marketing.generate:${id}`, maxAttempts: 1,
    }, tx);
    const requested = await prepareAudit(db, {
      organizationId: orgId, action: 'marketing.report_requested', targetTable: 'marketing_reports', targetId: id,
      after: { job_id: job.id },
    }, tx);
    const enqueued = await prepareAudit(db, {
      organizationId: orgId, action: 'job.enqueued', targetTable: 'jobs', targetId: job.id,
      after: { job_type: 'marketing.generate' },
    }, tx);
    const now = nowIso();
    tx.set(orgRow(db.fs, orgId, 'marketing_reports', id), {
      id, organization_id: orgId, status: 'queued', report: null, report_version: null, failure: null,
      requested_by: actor, job_id: job.id, model: null, prompt_version: null, input_tokens: 0, output_tokens: 0,
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    });
    // A guard left by an attempt that already ended is re-pointed at this one.
    tx.set(once.ref, { owner_id: id, constraint: 'marketing_reports_one_in_flight', created_at: now });
    job.write(tx);
    requested.write(tx);
    enqueued.write(tx);
    return { report_id: id, created: true };
  });
}

export const functions: DbFunctions = {
  set_company_profile,
  request_marketing_report,
};
