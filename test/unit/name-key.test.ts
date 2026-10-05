import { describe, expect, it } from 'vitest';
import { heldNameKey, storedNameKey } from '@/modules/imports';

/**
 * The identity key's matching rules (ADR-136), stated as cases. The same table runs against the
 * database's `app.normalize_name` in supabase/tests/21_unicode_names.test.sql, and the two
 * implementations are compared over every code point in test/integration/unicode-names.test.ts.
 */

/** Pairs that are ONE name. */
const SAME: ReadonlyArray<readonly [string, string, string]> = [
  ['case, Latin', 'Acme Ltd', 'ACME LTD'],
  ['punctuation and spacing', 'Acme & Co.', 'acme  co'],
  ['case, accented', 'Müller GmbH', 'MÜLLER GMBH'],
  ['precomposed = combining accent (NFKC)', 'Müller', 'Müller'],
  ['full-width = ASCII (NFKC)', 'Ａｃｍｅ', 'Acme'],
  ['ligature (NFKC)', 'ﬁnance', 'finance'],
  ['half-width katakana = full-width (NFKC)', 'ｶﾌﾞｼｷｶﾞｲｼｬ', 'カブシキガイシャ'],
  ['case, Greek, final sigma', 'ΟΔΟΣ Α.Ε.', 'οδος α.ε.'],
  ['case, Cyrillic, guillemets are punctuation', 'ООО «Ромашка»', 'ооо ромашка'],
  ['dotted capital I (simple mapping)', 'İzmir', 'izmir'],
  ['Japanese middle dot is punctuation', 'Tokyo・Trading', 'Tokyo Trading'],
];

/** Pairs that are TWO names: never merged. */
const DIFFERENT: ReadonlyArray<readonly [string, string, string]> = [
  ['different accented letter', 'Müller GmbH', 'Möller GmbH'],
  ['accent against no accent', 'Müller GmbH', 'Muller GmbH'],
  ['é against e', 'Café Sales', 'Cafe Sales'],
  ['Cyrillic against Latin look-alike', 'Асме', 'Acme'],
  ['different Japanese names', '株式会社トヨタ', '株式会社ホンダ'],
  ['different Arabic names', 'شركة الأمل', 'شركة النور'],
  ['Arabic-Indic digits are significant', 'متجر ٣', 'متجر ٤'],
  ['Arabic-Indic and ASCII digits are different characters', 'Unit ٣', 'Unit 3'],
  ['a combining mark no letter absorbs is kept', 'q̃x', 'qx'],
  ['ß is not ss (simple case mapping only)', 'Straße', 'Strasse'],
  ['words joined against apart', 'Acme Co', 'AcmeCo'],
];

describe('the identity key (ADR-136)', () => {
  it.each(SAME)('one name: %s', (_rule, a, b) => {
    expect(storedNameKey(a)).toBe(storedNameKey(b));
    expect(storedNameKey(a)).not.toBe('');
  });

  it.each(DIFFERENT)('two names: %s', (_rule, a, b) => {
    expect(storedNameKey(a)).not.toBe(storedNameKey(b));
  });

  it('keeps every script, and the display name is never the key', () => {
    expect(storedNameKey('株式会社トヨタ')).toBe('株式会社トヨタ');
    expect(storedNameKey('شركة الأمل')).toBe('شركة الأمل');
    expect(storedNameKey('ΟΔΟΣ Α.Ε.')).toBe('οδοσ α ε');
    expect(storedNameKey('ООО «Ромашка»')).toBe('ооо ромашка');
  });

  it('is the old [a-z0-9] key for every ASCII character', () => {
    const old = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (let cp = 1; cp < 128; cp += 1) {
      const name = `a${String.fromCharCode(cp)}b`;
      expect(storedNameKey(name), `U+${cp.toString(16)}`).toBe(old(name));
    }
  });

  it('is empty only for a name of punctuation and symbols', () => {
    expect(storedNameKey('★ — ★')).toBe('');
    expect(storedNameKey('٣')).toBe('٣');
  });

  it('reads a held key back, and only a held key', () => {
    expect(heldNameKey('izmir ltd [held 0b000000-0000-4000-8000-000000000001]')).toBe('izmir ltd');
    expect(heldNameKey('izmir ltd')).toBeNull();
    // An import key can never look held: '[' is punctuation, so no key contains it.
    expect(storedNameKey('Izmir Ltd [held 0b000000-0000-4000-8000-000000000001]')).not.toContain('[');
  });
});
