import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { auth } from '@/db/firestore';
import { globalRow, orgCollection, orgRow } from '@/db/schema';
import { clientFor, createAuthUser, fs, rpc as call, sqlstate } from './setup';
import { dropOrg } from './tenancy-fixtures';

/**
 * ADR-156 against the data layer: the tax settings, a loan's security marking, and currency/country
 * after creation. Each is called as the owner, with the owner's own handle, through `api.*`.
 */

const RUN = `tx${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.tax.itest.motion`;
let ownerId: string;
let orgId: string;

const VALIDATION = '22023';

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) => call(clientFor(userId), fn, args);

async function accountOf(category: string): Promise<string> {
  const snap = await orgCollection(fs(), orgId, 'accounts')
    .where('standard_category', '==', category).where('is_system', '==', true).limit(1).get();
  return snap.docs[0]!.id;
}

const org = async () => (await globalRow(fs(), 'organizations', orgId).get()).data()!;
const loanSecurity = async (accountId: string) =>
  ((await orgRow(fs(), orgId, 'accounts', accountId).get()).get('loan_security') as string | null) ?? 'NULL';

beforeAll(async () => {
  ownerId = await createAuthUser(`tax-owner@${DOMAIN}`);
  const created = await rpc(ownerId, 'create_organization', { p_name: `ITest Tax Settings ${RUN}` });
  if (created.error) throw created.error;
  orgId = created.data as string;
});

afterAll(async () => {
  if (orgId) await dropOrg(orgId);
  await auth().deleteUser(ownerId).catch(() => undefined);
  await globalRow(fs(), 'profiles', ownerId).delete();
});

describe('api.set_tax_settings', () => {
  it('stores the three keys in organizations.settings', async () => {
    const { error } = await rpc(ownerId, 'set_tax_settings', {
      p_org: orgId, p_vat_quarter_end_month: 2, p_vat_scheme: 'cash_accounting', p_ct_associated_companies: 3,
    });
    expect(error).toBeNull();
    const s = (await org()).settings as Record<string, unknown>;
    expect({ m: s.vat_quarter_end_month, s: s.vat_scheme, a: s.ct_associated_companies })
      .toEqual({ m: 2, s: 'cash_accounting', a: 3 });
  });

  it('rejects a quarter-end month of 4', async () => {
    const { error } = await rpc(ownerId, 'set_tax_settings', {
      p_org: orgId, p_vat_quarter_end_month: 4, p_vat_scheme: 'standard', p_ct_associated_companies: 0,
    });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(((await org()).settings as Record<string, unknown>).vat_quarter_end_month).toBe(2);
  });
});

describe('api.set_account_loan_security', () => {
  it('marks a loan account secured, and unmarked clears it', async () => {
    const loan = await accountOf('loan');
    const marked = await rpc(ownerId, 'set_account_loan_security', { p_account: loan, p_security: 'secured' });
    expect(marked.error).toBeNull();
    expect(await loanSecurity(loan)).toBe('secured');

    const cleared = await rpc(ownerId, 'set_account_loan_security', { p_account: loan, p_security: 'unmarked' });
    expect(cleared.error).toBeNull();
    expect(await loanSecurity(loan)).toBe('NULL');
  });

  it('marks a long-term liability account', async () => {
    const longTerm = await accountOf('long_term_liability');
    const { error } = await rpc(ownerId, 'set_account_loan_security', { p_account: longTerm, p_security: 'unsecured' });
    expect(error).toBeNull();
    expect(await loanSecurity(longTerm)).toBe('unsecured');
  });

  it('refuses a cash account', async () => {
    const cash = await accountOf('cash');
    const { error } = await rpc(ownerId, 'set_account_loan_security', { p_account: cash, p_security: 'secured' });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(await loanSecurity(cash)).toBe('NULL');
  });
});

describe('api.set_currency_and_country', () => {
  const current = async () => {
    const o = await org();
    return `${o.base_currency}/${o.country_code}`;
  };

  it('changes the currency of an organisation with no financial records', async () => {
    const { error } = await rpc(ownerId, 'set_currency_and_country', {
      p_org: orgId, p_currency: 'AED', p_country: 'AE',
    });
    expect(error).toBeNull();
    expect(await current()).toBe('AED/AE');
  });

  it('refuses a currency change once a bank account exists, but still changes the country', async () => {
    const bank = await rpc(ownerId, 'create_bank_account', {
      p_org: orgId, p_input: { name: 'Current account', bank_name: 'Test Bank' },
    });
    expect(bank.error).toBeNull();

    const refused = await rpc(ownerId, 'set_currency_and_country', {
      p_org: orgId, p_currency: 'GBP', p_country: 'AE',
    });
    expect(sqlstate(refused.error)).toBe(VALIDATION);
    expect(refused.error?.message).toMatch(/currency cannot change once financial records exist/);
    expect(await current()).toBe('AED/AE');

    const countryOnly = await rpc(ownerId, 'set_currency_and_country', {
      p_org: orgId, p_currency: 'AED', p_country: 'GB',
    });
    expect(countryOnly.error).toBeNull();
    expect(await current()).toBe('AED/GB');
  });
});
