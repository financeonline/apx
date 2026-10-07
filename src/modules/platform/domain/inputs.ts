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
});
export type CreateCompanyInput = z.infer<typeof CreateCompanyInput>;

export const PLATFORM_ROLES = ['super_admin', 'employee'] as const;
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
