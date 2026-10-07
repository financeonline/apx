/**
 * What a super admin types into the platform forms (ADR-158). Pure.
 *
 * These are the first check, not the only one: `api.platform_create_organization` and
 * `api.grant_platform_role` re-validate everything here. What the schemas buy is a field-level
 * message for the person filling in the form instead of a SQLSTATE.
 */
import { z } from 'zod';
import { ValidationError } from '@/core/errors';

export const COMPANY_COUNTRIES = ['GB', 'AE', 'IE', 'IN'] as const;

export const COMPANY_CURRENCIES = ['GBP', 'AED', 'EUR', 'USD', 'INR'] as const;

const EMAIL = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));

export const CreateCompanyInput = z.object({
  name: z.string().trim().min(1, 'Enter the company name').max(200, 'Keep the name under 200 characters'),
  countryCode: z.enum(COMPANY_COUNTRIES, 'Choose a country'),
  baseCurrency: z.enum(COMPANY_CURRENCIES, 'Choose a currency'),
  fiscalYearStartMonth: z.coerce.number().int().min(1, 'Choose a month').max(12, 'Choose a month'),
  ownerEmail: EMAIL,
  /**
   * ADR-160: optional. When given, the owner's login is created with it and they are the owner at
   * once; when empty, they join through the invitation link. Never trimmed: spaces are characters.
   */
  ownerPassword: z.union([
    z.literal(''),
    z.string().min(8, 'Use at least 8 characters for the password').max(72, 'Keep the password under 72 characters'),
  ]).default(''),
});
export type CreateCompanyInput = z.infer<typeof CreateCompanyInput>;

export const COMPANY_PLANS = ['trial', 'starter', 'professional', 'enterprise'] as const;

/** ADR-166: what the super admin may edit about a company from the list. */
export const EditCompanyInput = z.object({
  name: z.string().trim().min(1, 'Enter the company name').max(200, 'Keep the name under 200 characters'),
  legalName: z.string().trim().max(200, 'Keep the legal name under 200 characters').default(''),
  countryCode: z.enum(COMPANY_COUNTRIES, 'Choose a country'),
  baseCurrency: z.enum(COMPANY_CURRENCIES, 'Choose a currency'),
  fiscalYearStartMonth: z.coerce.number().int().min(1, 'Choose a month').max(12, 'Choose a month'),
  plan: z.enum(COMPANY_PLANS, 'Choose a plan'),
});
export type EditCompanyInput = z.infer<typeof EditCompanyInput>;

/** ADR-159: one super admin, so anyone added is staff. */
export const PLATFORM_ROLES = ['employee'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const AddPlatformUserInput = z.object({
  email: EMAIL,
  role: z.enum(PLATFORM_ROLES, 'Choose a role'),
});
export type AddPlatformUserInput = z.infer<typeof AddPlatformUserInput>;

/** Parse or throw a ValidationError listing each field's problem. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Some details need fixing.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
