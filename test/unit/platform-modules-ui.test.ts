import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import { AddPlatformUserInput, CreateCompanyInput, parseInput } from '@/modules/platform';

describe('platform form inputs (ADR-158)', () => {
  it('reads a company from the form, trimming and lower-casing the owner email', () => {
    const value = parseInput(CreateCompanyInput, {
      name: '  Acme Ltd ', countryCode: 'GB', baseCurrency: 'GBP', fiscalYearStartMonth: '4', ownerEmail: ' Owner@Example.COM ',
    });
    expect(value).toEqual({ name: 'Acme Ltd', countryCode: 'GB', baseCurrency: 'GBP', fiscalYearStartMonth: 4, ownerEmail: 'owner@example.com' });
  });

  it('refuses a country, currency or month the database would refuse, field by field', () => {
    try {
      parseInput(CreateCompanyInput, { name: '', countryCode: 'US', baseCurrency: 'JPY', fiscalYearStartMonth: '13', ownerEmail: 'nope' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const paths = (error as ValidationError).issues.map((i) => i.path).sort();
      expect(paths).toEqual(['baseCurrency', 'countryCode', 'fiscalYearStartMonth', 'name', 'ownerEmail']);
    }
  });

  it('accepts only the two platform roles', () => {
    expect(parseInput(AddPlatformUserInput, { email: 'a@b.co', role: 'super_admin' }).role).toBe('super_admin');
    expect(parseInput(AddPlatformUserInput, { email: 'a@b.co', role: 'employee' }).role).toBe('employee');
    expect(() => parseInput(AddPlatformUserInput, { email: 'a@b.co', role: 'owner' })).toThrow(ValidationError);
    expect(() => parseInput(AddPlatformUserInput, { email: 'not an email', role: 'employee' })).toThrow(ValidationError);
  });
});
