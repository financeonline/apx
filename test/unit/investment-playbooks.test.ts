import { describe, expect, it } from 'vitest';

const {
  CRYPTO_PATTERN, INVESTMENT_PLAYBOOKS, NAMED_PRODUCT_WORDS, defaultOptions, defaultReferences, playbookFor, playbookLink,
} = await import('@/modules/investment/domain/playbooks');
const {
  HIGH_RISK_CAP_PCT, HIGH_RISK_LEVELS, INVESTMENT_NARRATIVE_BOUNDS: B, InvestmentLeverSchema, InvestmentOptionSchema,
  PortfolioShareSchema, ProcessStageSchema, riskRank,
} = await import('@/modules/investment/domain/narrative-schema');

/**
 * ADR-171: the hard-coded country playbooks steer the prompt, are the ONLY links a pack may cite, and
 * stand in for the model offline — so each must be sound on its own: a ladder ordered by risk, a
 * portfolio adding to 100 inside the 10% high-risk limit, every link a real https homepage it refers
 * to by id, every string inside the narrative schema, the right regulators for the right country, and
 * nothing that names a fund to buy.
 */

const sum = (values: readonly string[]) => values.reduce((a, v) => a + Number.parseInt(v, 10), 0);

describe('playbookFor', () => {
  it.each([
    ['GB', 'GB'], ['gb', 'GB'], [' UK ', 'GB'], ['AE', 'AE'], ['ie', 'IE'], ['IN', 'IN'],
    ['US', 'generic'], ['FR', 'generic'], ['', 'generic'], [null, 'generic'], [undefined, 'generic'],
  ] as const)('%s → %s', (code, key) => {
    expect(playbookFor(code).key).toBe(key);
  });
});

describe('every playbook', () => {
  const cases = INVESTMENT_PLAYBOOKS.map((p) => [p.key, p] as const);

  it.each(cases)('%s has a ladder ordered from lower to very high risk, with crypto only at very high', (_key, p) => {
    const ranks = p.ladder.map((o) => riskRank(o.risk));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(p.ladder.map((o) => o.id)).toEqual([...new Set(p.ladder.map((o) => o.id))]);
    for (const o of p.ladder) {
      expect(InvestmentOptionSchema.safeParse({ name: o.name, risk: o.risk, description: o.description, referenceUrl: null }).success, o.id).toBe(true);
      if (CRYPTO_PATTERN.test(`${o.name} ${o.description}`)) expect(o.risk, o.id).toBe('very_high');
    }
    expect(p.ladder.some((o) => o.risk === 'lower')).toBe(true);
    expect(p.ladder.some((o) => o.id === 'crypto' && o.risk === 'very_high')).toBe(true);
  });

  it.each(cases)('%s offers five default options, in order, within the bounds', (_key, p) => {
    const options = defaultOptions(p);
    expect(options).toHaveLength(5);
    expect(options.length).toBeGreaterThanOrEqual(B.options.min);
    expect(options.length).toBeLessThanOrEqual(B.options.max);
    expect(options.map((o) => o.risk)).toEqual(['lower', 'low_medium', 'higher', 'high', 'very_high']);
    for (const id of p.defaultOptionIds) expect(p.ladder.map((o) => o.id)).toContain(id);
  });

  it.each(cases)('%s has a portfolio adding to 100 inside the 10% high-risk limit', (_key, p) => {
    expect(sum(p.portfolio.map((s) => s.percent))).toBe(100);
    const high = p.portfolio.filter((s) => HIGH_RISK_LEVELS.has(s.risk)).map((s) => s.percent);
    expect(sum(high)).toBeLessThanOrEqual(HIGH_RISK_CAP_PCT);
    expect(p.portfolio.length).toBeGreaterThanOrEqual(B.portfolio.min);
    expect(p.portfolio.length).toBeLessThanOrEqual(B.portfolio.max);
    for (const s of p.portfolio) expect(PortfolioShareSchema.safeParse(s).success, s.assetClass).toBe(true);
  });

  it.each(cases)('%s links only to https homepages it lists once, and every id it uses exists', (_key, p) => {
    const ids = p.links.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(p.links.map((l) => l.url)).size).toBe(p.links.length);
    for (const l of p.links) {
      const url = new URL(l.url);
      expect(url.protocol, l.id).toBe('https:');
      expect(url.search, l.id).toBe('');
      expect(l.label.length, l.id).toBeLessThanOrEqual(120);
      // A front door, not a product page: at most two path segments (gov.uk's organisation page).
      expect(url.pathname.split('/').filter(Boolean).length, l.id).toBeLessThanOrEqual(3);
    }
    for (const o of p.ladder) if (o.linkId !== null) expect(playbookLink(p, o.linkId), `${o.id} → ${o.linkId}`).toBeDefined();
    for (const id of p.defaultReferenceIds) expect(playbookLink(p, id), id).toBeDefined();
    const refs = defaultReferences(p);
    expect(refs.length).toBeGreaterThanOrEqual(B.references.min);
    expect(refs.length).toBeLessThanOrEqual(B.references.max);
    expect(p.links.some((l) => l.kind === 'regulator' && p.defaultReferenceIds.includes(l.id))).toBe(true);
  });

  it.each(cases)('%s has levers, a process and controls inside the schema', (_key, p) => {
    expect(p.levers.length).toBeGreaterThanOrEqual(B.levers.min);
    for (const l of p.levers) expect(InvestmentLeverSchema.safeParse(l).success, l.lever).toBe(true);
    expect(p.process.map((s) => s.stage)).toEqual(p.process.map((_, i) => i + 1));
    expect(p.process.length).toBeGreaterThanOrEqual(B.process.min);
    for (const s of p.process) expect(ProcessStageSchema.safeParse(s).success, s.action).toBe(true);
    expect(p.governance.length).toBeGreaterThanOrEqual(B.governance.min);
    expect(p.governance.length).toBeLessThanOrEqual(B.governance.max);
    for (const g of p.governance) expect(g.length).toBeLessThanOrEqual(200);
    expect(p.notes.length).toBeGreaterThan(0);
  });

  it.each(cases)('%s never names a fund, platform or coin in what a pack prints', (_key, p) => {
    const printed = [
      ...p.ladder.flatMap((o) => [o.name, o.description]), ...p.portfolio.map((s) => s.assetClass),
      ...p.levers.flatMap((l) => [l.lever, l.action, l.measure]), ...p.process.map((s) => s.action), ...p.governance,
    ].join(' | ');
    for (const word of NAMED_PRODUCT_WORDS) {
      expect(new RegExp(`(?<![A-Za-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(printed), word).toBe(false);
    }
    // No rate, limit or threshold that would go stale: no percentages or amounts at all.
    expect(printed).not.toMatch(/\d\s?%|[£€$₹]\s?\d|AED\s?\d/);
  });

  it('uses UK spelling in what reaches the pack (names of bodies, such as IOSCO\'s, stay as they are)', () => {
    const text = JSON.stringify(INVESTMENT_PLAYBOOKS.map(({ links: _names, ...rest }) => rest)).toLowerCase();
    for (const us of ['prioritize', 'organization', 'program ', 'favor', 'center ', 'license ', 'capitalize', 'optimize']) {
      expect(text.includes(us), us).toBe(false);
    }
  });
});

describe('each country names its own regulators and protection', () => {
  const urls = (key: string) => playbookFor(key).links.map((l) => l.url);

  it('the United Kingdom: FCA and its register, FSCS, the DMO, MoneyHelper; a SIPP for directors', () => {
    expect(urls('GB')).toEqual(expect.arrayContaining([
      'https://www.fca.org.uk/', 'https://register.fca.org.uk/', 'https://www.fscs.org.uk/', 'https://www.dmo.gov.uk/', 'https://www.moneyhelper.org.uk/',
    ]));
    const pension = playbookFor('GB').ladder.find((o) => o.id === 'pension');
    expect(pension?.description).toContain('SIPP');
    expect(playbookFor('GB').process[2]!.action).toBe('Select FCA-authorised providers and corporate accounts');
    expect(playbookFor('GB').levers[2]!.action).toBe('New UK and international channels');
  });

  it('the UAE: SCA, DFSA and the Central Bank', () => {
    expect(urls('AE')).toEqual(expect.arrayContaining(['https://www.sca.gov.ae/', 'https://www.dfsa.ae/', 'https://www.centralbank.ae/']));
  });

  it('Ireland: the Central Bank and the Investor Compensation Company', () => {
    expect(urls('IE')).toEqual(expect.arrayContaining(['https://www.centralbank.ie/', 'https://www.investorcompensation.ie/']));
  });

  it('India: SEBI and the RBI, with section 186 among the controls', () => {
    expect(urls('IN')).toEqual(expect.arrayContaining(['https://www.sebi.gov.in/', 'https://www.rbi.org.in/']));
    expect(playbookFor('IN').governance.join(' ')).toContain('section 186');
  });

  it('anywhere else: the international bodies, and no country\'s own regulator', () => {
    const generic = urls('US');
    expect(generic).toEqual(expect.arrayContaining(['https://www.iosco.org/', 'https://www.iadi.org/']));
    expect(generic.join(' ')).not.toMatch(/fca|sebi|centralbank/);
  });
});
