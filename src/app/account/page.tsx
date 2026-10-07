import { redirect } from 'next/navigation';
import { createUserClient } from '@/core/db/user-client';
import { PageHeader, Card, CardHeader, CardBody } from '@/components/ui/surfaces';
import { ProfileForm } from './profile-form';
import { BrandedScreen } from '@/components/dashboard/branded-screen';
import { KeyRound } from 'lucide-react';
import { formatDateTime } from '@/components/labels';
import { AiKeyForm } from './ai-key-form';
import { AiModelForm } from './ai-model-form';
import { ProviderActivation } from './provider-activation';
import { timeZoneOptions } from '@/components/time-zones';
import { getPlatformContext } from '@/modules/tenancy';
import { loadAiModelSettings, loadOpenAiKeyStatus, type AiModelSettings } from '@/modules/platform';
import { SignOutButton } from '@/components/dashboard/sign-out-button';

export const dynamic = 'force-dynamic';

interface ProfileRow {
  full_name: string | null;
  email: string;
  timezone: string;
}

export default async function AccountPage() {
  const db = await createUserClient();
  const { data: session } = await db.auth.getUser();
  if (!session.user) redirect('/sign-in?next=/account');

  const { data } = await db.schema('api').rpc('my_profile');
  const profile = (data as ProfileRow[] | null)?.[0];

  // ADR-157: the AI provider key is managed here, by the super admin only; nobody else's profile
  // shows it.
  const { data: roleRows } = await db.schema('api').rpc('my_platform_role');
  const role = (roleRows as Array<{ platform_role: string; status: string }> | null)?.[0];
  const superAdmin = role?.platform_role === 'super_admin' && role.status === 'active';
  let aiKey: { configured: boolean; ending: string | null; updatedAt: string | null } | null = null;
  if (superAdmin) {
    const { data: keyRows } = await db.schema('api').rpc('ai_api_key_status');
    const row = (keyRows as Array<{ configured: boolean; ending: string | null; updated_at: string | null }> | null)?.[0];
    aiKey = { configured: row?.configured === true, ending: row?.ending ?? null, updatedAt: row?.updated_at ?? null };
  }
  const serverFallback = Boolean(process.env.ANTHROPIC_API_KEY);
  // ADR-163: the model and effort, offered from the provider's list for the key in use.
  const platformCtx = superAdmin ? await getPlatformContext() : null;
  const aiModel: AiModelSettings | null = platformCtx ? await loadAiModelSettings(platformCtx) : null;
  // ADR-164: the OpenAI key, beside the Anthropic one.
  const openAiKey = platformCtx ? await loadOpenAiKeyStatus(platformCtx) : null;

  // Each provider card says its own model; the active badge says which one the AI uses (ADR-165).
  const nameOf = (provider: 'anthropic' | 'openai', id: string) =>
    aiModel?.options.find((o) => o.provider === provider && o.id === id)?.name ?? (provider === 'openai' ? `OpenAI ${id}` : id);
  const modelLine = (provider: 'anthropic' | 'openai') => {
    const slot = provider === 'openai' ? aiModel?.openai : aiModel?.anthropic;
    if (slot) return <>Model: <span className="font-medium">{nameOf(provider, slot.model)}</span>{slot.effort ? `, ${slot.effort} effort` : ', its default effort'}.</>;
    if (provider === 'anthropic' && aiModel) return <>Model: the default, <span className="font-medium">{nameOf('anthropic', aiModel.defaultModel)}</span>.</>;
    return <>No OpenAI model chosen yet.</>;
  };

  return (
    <BrandedScreen width={superAdmin ? '6xl' : '2xl'} panel={false}>
      <PageHeader
        title="Your account" description="Your details."
        action={<SignOutButton className="w-36 rounded-xl border border-line bg-surface" />}
      />
      <div className={superAdmin ? 'grid grid-cols-1 items-start gap-6 lg:grid-cols-2' : 'flex flex-col gap-6'}>
        {/* Two columns that stack independently, so a tall card never leaves a gap beside it. */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title="Your details" />
            <CardBody>
              <ProfileForm
                fullName={profile?.full_name ?? ''}
                email={profile?.email ?? session.user.email ?? ''}
                timezone={profile?.timezone ?? 'Europe/London'}
                timeZones={timeZoneOptions(profile?.timezone ?? 'Europe/London')}
              />
            </CardBody>
          </Card>
          {openAiKey ? (
            <Card>
              <CardHeader
                icon={<KeyRound />} tint="violet" title="OpenAI key"
                description="Store an OpenAI key to choose an OpenAI model for the AI. Only super admins see this."
              />
              <CardBody className="flex flex-col gap-4">
                {aiModel ? (
                <ProviderActivation
                  provider="openai" active={aiModel.active === 'openai'} otherName="Anthropic"
                  blockedReason={!openAiKey.configured
                    ? 'Store an OpenAI key and choose a model below to make OpenAI active.'
                    : !aiModel.openai ? 'Choose an OpenAI model below to make OpenAI active.' : null}
                />
              ) : null}
              <p className="text-sm text-ink" data-testid="openai-key-status">
                  {openAiKey.configured
                    ? <>A key ending <span className="font-mono">…{openAiKey.ending}</span> is stored{openAiKey.updatedAt ? `, set ${formatDateTime(openAiKey.updatedAt)}` : ''}.</>
                    : 'No OpenAI key is stored. The AI uses Anthropic.'}
                </p>
                <AiKeyForm configured={openAiKey.configured} provider="openai" />
              {aiModel ? (
                <div className="flex flex-col gap-3 border-t border-line pt-4">
                  <p className="text-sm text-ink" data-testid="openai-model-status">{modelLine('openai')}</p>
                  <AiModelForm
                    provider="openai" options={aiModel.options}
                    chosenModel={aiModel.openai ? `openai:${aiModel.openai.model}` : null}
                    chosenEffort={aiModel.openai?.effort ?? null} defaultModel={aiModel.defaultModel}
                    unavailable={!openAiKey.configured
                      ? 'Store an OpenAI key above, then choose its model and effort here.'
                      : aiModel.options.some((o) => o.provider === 'openai') ? null : 'The list of OpenAI models could not be read just now. Refresh to try again.'}
                  />
                </div>
              ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
        {superAdmin ? (
          <div className="flex min-w-0 flex-col gap-6">
            <Card>
              <CardHeader
                icon={<KeyRound />} tint="pink" title="AI provider key"
                description="The Anthropic key, and the model every organisation's AI Analyst and document reading use. Only super admins see this."
              />
              <CardBody className="flex flex-col gap-4">
                {aiKey === null ? null : (
                  <>
                    {aiModel ? (
                      <ProviderActivation provider="anthropic" active={aiModel.active === 'anthropic'} otherName="OpenAI" blockedReason={null} />
                    ) : null}
                    <p className="text-sm text-ink" data-testid="ai-key-status">
                      {aiKey.configured
                        ? <>A key ending <span className="font-mono">…{aiKey.ending}</span> is stored{aiKey.updatedAt ? `, set ${formatDateTime(aiKey.updatedAt)}` : ''}.</>
                        : serverFallback
                          ? 'No key is stored here; the AI is using the key in the server settings.'
                          : 'No key is set, so the AI is switched off until one is added.'}
                    </p>
                    <AiKeyForm configured={aiKey.configured} />
                    {aiModel ? (
                      <div className="flex flex-col gap-3 border-t border-line pt-4">
                        <p className="text-sm text-ink" data-testid="ai-model-status">{modelLine('anthropic')}</p>
                        {aiModel.options.some((o) => o.provider === 'anthropic') ? (
                          <AiModelForm
                            provider="anthropic" options={aiModel.options}
                            chosenModel={aiModel.anthropic ? `anthropic:${aiModel.anthropic.model}` : null}
                            chosenEffort={aiModel.anthropic?.effort ?? null} defaultModel={aiModel.defaultModel}
                          />
                        ) : (
                          <p className="text-sm text-ink-muted">The list of models could not be read from Anthropic just now. Refresh to try again.</p>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </CardBody>
            </Card>
          </div>
        ) : null}
      </div>
    </BrandedScreen>
  );
}
