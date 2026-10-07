import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { adminSql, clientFor, createAuthUser, resetFixtures, sqlstate } from './setup';

/**
 * ADR-156 over the real wire: the tax settings, a loan's security marking, and currency/country
 * after creation. Each is called as the owner, under a real JWT, through `api.*`.
 */

let ownerId: string;
let orgId: string;

const VALIDATION = '22023';

const rpc = (userId: string, fn: string, args: Record<string, unknown> = {}) =>
  clientFor(userId).schema('api').rpc(fn, args);

const accountOf = (category: string) =>
  adminSql(`select id from public.accounts where organization_id = '${orgId}'
             and standard_category = '${category}' and is_system limit 1`);

beforeAll(async () => {
  resetFixtures();
  ownerId = createAuthUser('tax-owner@itest.motion');
  const created = await rpc(ownerId, 'create_organization', { p_name: 'ITest Tax Settings' });
  if (created.error) throw new Error(`fixture org failed: ${created.error.message}`);
  orgId = created.data as unknown as string;
});

afterAll(() => {
  resetFixtures();
});

describe('api.set_tax_settings', () => {
  it('stores the three keys in organizations.settings', async () => {
    const { error } = await rpc(ownerId, 'set_tax_settings', {
      p_org: orgId, p_vat_quarter_end_month: 2, p_vat_scheme: 'cash_accounting', p_ct_associated_companies: 3,
    });
    expect(error).toBeNull();
    const stored = JSON.parse(adminSql(`
      select jsonb_build_object('m', settings -> 'vat_quarter_end_month', 's', settings -> 'vat_scheme',
                                'a', settings -> 'ct_associated_companies')
        from public.organizations where id = '${orgId}'`));
    expect(stored).toEqual({ m: 2, s: 'cash_accounting', a: 3 });
  });

  it('rejects a quarter-end month of 4', async () => {
    const { error } = await rpc(ownerId, 'set_tax_settings', {
      p_org: orgId, p_vat_quarter_end_month: 4, p_vat_scheme: 'standard', p_ct_associated_companies: 0,
    });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(adminSql(`select settings ->> 'vat_quarter_end_month' from public.organizations where id = '${orgId}'`))
      .toBe('2');
  });
});

describe('api.set_account_loan_security', () => {
  it('marks a loan account secured, and unmarked clears it', async () => {
    const loan = accountOf('loan');
    const marked = await rpc(ownerId, 'set_account_loan_security', { p_account: loan, p_security: 'secured' });
    expect(marked.error).toBeNull();
    expect(adminSql(`select loan_security from public.accounts where id = '${loan}'`)).toBe('secured');

    const cleared = await rpc(ownerId, 'set_account_loan_security', { p_account: loan, p_security: 'unmarked' });
    expect(cleared.error).toBeNull();
    expect(adminSql(`select coalesce(loan_security::text, 'NULL') from public.accounts where id = '${loan}'`))
      .toBe('NULL');
  });

  it('marks a long-term liability account', async () => {
    const longTerm = accountOf('long_term_liability');
    const { error } = await rpc(ownerId, 'set_account_loan_security', { p_account: longTerm, p_security: 'unsecured' });
    expect(error).toBeNull();
    expect(adminSql(`select loan_security from public.accounts where id = '${longTerm}'`)).toBe('unsecured');
  });

  it('refuses a cash account', async () => {
    const cash = accountOf('cash');
    const { error } = await rpc(ownerId, 'set_account_loan_security', { p_account: cash, p_security: 'secured' });
    expect(sqlstate(error)).toBe(VALIDATION);
    expect(adminSql(`select coalesce(loan_security::text, 'NULL') from public.accounts where id = '${cash}'`))
      .toBe('NULL');
  });
});

describe('api.set_currency_and_country', () => {
  const current = () =>
    adminSql(`select base_currency || '/' || country_code from public.organizations where id = '${orgId}'`);

  it('changes the currency of an organisation with no financial records', async () => {
    const { error } = await rpc(ownerId, 'set_currency_and_country', {
      p_org: orgId, p_currency: 'AED', p_country: 'AE',
    });
    expect(error).toBeNull();
    expect(current()).toBe('AED/AE');
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
    expect(refused.error?.message).toMatch(/^VALIDATION:/);
    expect(current()).toBe('AED/AE');

    const countryOnly = await rpc(ownerId, 'set_currency_and_country', {
      p_org: orgId, p_currency: 'AED', p_country: 'GB',
    });
    expect(countryOnly.error).toBeNull();
    expect(current()).toBe('AED/GB');
  });
});
