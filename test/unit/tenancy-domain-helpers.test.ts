import { describe, expect, it } from 'vitest';
import {
  DEPARTMENT_KEYS, MODULES, MODULE_KEYS, USER_ID_PATTERN, createsMembers, enabledModules, isDepartmentKey, isModuleKey,
  isUserId, moduleDefinition, parseOverrideDetails,
} from '@/modules/tenancy';

/**
 * The small tenancy domain helpers the pages and the api functions lean on. They are tiny, which is
 * why they had no tests of their own — and why the coverage gate on `modules/tenancy/domain`
 * (vitest.config, 95%) failed on CI the first time it ran (2026-11-02).
 */

describe('modules: definitions and the enabled set', () => {
  it('finds every module by its key, with the key it was asked for', () => {
    for (const key of MODULE_KEYS) {
      const def = moduleDefinition(key);
      expect(def.key).toBe(key);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.featureKey.length).toBeGreaterThan(0);
    }
    expect(MODULES.map((m) => m.key)).toEqual([...MODULE_KEYS]);
  });

  it('isModuleKey accepts the known keys and nothing else', () => {
    for (const key of MODULE_KEYS) expect(isModuleKey(key)).toBe(true);
    expect(isModuleKey('')).toBe(false);
    expect(isModuleKey('Marketing')).toBe(false);
    expect(isModuleKey('module_marketing')).toBe(false);
  });

  it('enabledModules: an absent feature follows the default, true switches on, false switches off', () => {
    const defaults = enabledModules(null);
    for (const m of MODULES) expect(defaults.has(m.key)).toBe(m.defaultOn);
    expect(enabledModules(undefined)).toEqual(defaults);

    const everything = enabledModules(Object.fromEntries(MODULES.map((m) => [m.featureKey, true])));
    expect([...everything].sort()).toEqual([...MODULE_KEYS].sort());

    const nothing = enabledModules(Object.fromEntries(MODULES.map((m) => [m.featureKey, false])));
    expect(nothing.size).toBe(0);

    // A value that is not a boolean is not "on": only `true` switches a system on.
    const odd = enabledModules(Object.fromEntries(MODULES.map((m) => [m.featureKey, 'yes'])));
    expect(odd.size).toBe(0);
  });
});

describe('departments: isDepartmentKey', () => {
  it('accepts every department key and refuses other values', () => {
    for (const key of DEPARTMENT_KEYS) expect(isDepartmentKey(key)).toBe(true);
    expect(isDepartmentKey('payroll')).toBe(false);
    expect(isDepartmentKey(null)).toBe(false);
    expect(isDepartmentKey(42)).toBe(false);
    expect(isDepartmentKey(['banking'])).toBe(false);
  });
});

describe('permissions: who set a switch, and who creates members', () => {
  it('parseOverrideDetails keeps the owner flag and the ceiling flag per switch', () => {
    const details = parseOverrideDetails([
      { permission: 'reports.generate', granted: false, set_by_owner: false, ceiling_withhold: false },
      { permission: 'ai.use', granted: true, set_by_owner: true, ceiling_withhold: true },
    ]);
    const byPermission = new Map(details.map((d) => [d.permission, d]));
    expect(byPermission.get('reports.generate')).toMatchObject({ granted: false, setByOwner: false, ceilingWithhold: false });
    expect(byPermission.get('ai.use')).toMatchObject({ granted: true, setByOwner: true, ceilingWithhold: true });
  });

  it('a missing or malformed flag reads as set by the owner (the locked answer), and junk is dropped', () => {
    const details = parseOverrideDetails([
      { permission: 'imports.review', granted: false },
      { permission: 'imports.review', granted: true, set_by_owner: false }, // a duplicate: the first wins
      'not an object',
      null,
      { permission: 7, granted: true },
    ]);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ permission: 'imports.review', setByOwner: true, ceilingWithhold: false });
    expect(parseOverrideDetails(null)).toEqual([]);
    expect(parseOverrideDetails({ permission: 'imports.review' })).toEqual([]);
  });

  it('only an owner creates the company’s members (ADR-174)', () => {
    expect(createsMembers('owner')).toBe(true);
    for (const role of ['admin', 'accountant', 'client', 'third_party', 'employee', 'super_admin', '']) {
      expect(createsMembers(role)).toBe(false);
    }
  });
});

describe('types: a person’s id is a Firebase Auth uid', () => {
  it('accepts uids and refuses anything else', () => {
    expect(isUserId('abc123_-XYZ')).toBe(true);
    expect(isUserId('a'.repeat(128))).toBe(true);
    expect(isUserId('a'.repeat(129))).toBe(false);
    expect(isUserId('')).toBe(false);
    expect(isUserId('has space')).toBe(false);
    expect(isUserId('dots.not.allowed')).toBe(false);
    expect(isUserId(123)).toBe(false);
    expect(isUserId(null)).toBe(false);
    expect(USER_ID_PATTERN.test('ok-id')).toBe(true);
  });
});
