import { assertCan } from '@/core/permissions';
import { loadPlatformSettings } from '@/modules/platform';
import { getPlatformContext } from '@/modules/tenancy';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/surfaces';
import { formatDateTime } from '@/components/labels';
import { SettingForm } from './setting-form';

export const dynamic = 'force-dynamic';

/**
 * Platform defaults (ROUTE_ARCHITECTURE.md §156; MVP_SCOPE.md §2.2).
 *
 * What every organisation gets unless `/platform/organizations/[orgId]` gives it its own — the
 * resolution `app.effective_quota` performs on every analyst turn and every page read by AI. Keys
 * the product knows are described; anything else in the table is still shown and editable as JSON,
 * because a setting nobody can see is a setting nobody can fix.
 */

const KNOWN: Readonly<Record<string, { label: string; hint: string; numeric: boolean }>> = {
  ai_quota_daily: {
    label: 'Analyst questions a day', numeric: true,
    hint: 'Per organisation. The turn is refused before the model is called, and the analyst says when it resets.',
  },
  ai_token_ceiling_monthly: {
    label: 'AI tokens a month', numeric: true,
    hint: 'Per organisation, shared by analyst turns and pages read by AI from PDFs.',
  },
  ai_extraction_pages_per_day: {
    label: 'Pages read by AI a day', numeric: true,
    hint: 'Charged per model call, so a page that fails and is retried costs each attempt.',
  },
  taxable_categories: {
    label: 'Categories counted as taxable', numeric: false,
    hint: 'A JSON list of standard categories. Read by the engine; changing it changes future figures, not past ones.',
  },
};

export default async function PlatformSettingsPage() {
  const ctx = await getPlatformContext();
  assertCan(ctx, 'system.manage');
  const settings = await loadPlatformSettings(ctx);

  return (
    <>
      <PageHeader title="Platform settings" description="The defaults every organisation gets unless it has its own." />
      <div className="mt-8 max-w-2xl">
        <Card>
          <CardHeader title="Defaults" />
          <CardBody>
            <div className="flex flex-col gap-4">
              {settings.map((setting) => {
                const known = KNOWN[setting.key];
                const value = typeof setting.value === 'number' || typeof setting.value === 'string'
                  ? String(setting.value)
                  : JSON.stringify(setting.value);
                return (
                  <div key={setting.key}>
                    <SettingForm
                      settingKey={setting.key}
                      label={known?.label ?? setting.key}
                      hint={known?.hint ?? 'Set by MOTION; edited as JSON.'}
                      value={value}
                      numeric={known?.numeric ?? false}
                    />
                    <p className="mt-1 text-xs text-ink-faint">Last changed {formatDateTime(setting.updatedAt)}</p>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
