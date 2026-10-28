import 'server-only';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import type { DbFunctions } from '../registry';
import { arg } from '../registry';
import { raise } from '../raise';
import { globalRow, newId, nowIso, orgRow, uniqueGuard, type OrgTable } from '../schema';
import { runTx } from '../tx';
import type { Db } from '../types';
import { hasPermissionOf, orgRoleOf } from '../app/access';
import { prepareAudit } from '../app/audit';
import { requireServer } from '../app/scope';
import { readSecret } from '../app/secrets';
import { throttle } from '../app/throttle';
import { aiTokensUsedThisMonth, effectiveQuota, userTurnsToday } from '../app/ai-quota';
import { conversationRow } from '../api/ai';

/**
 * `api_server.*` functions of the AI Analyst (AI_ARCHITECTURE.md §2, §4, §14; ADR-076, ADR-113,
 * ADR-157, ADR-163, ADR-164, ADR-170; R2-A-01), ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8).
 *
 * A turn is a server fact: the grounding status, the tool-call log, the token counts and the
 * evidence an answer cites are what the SERVER observed, so only the server writes them, for a
 * human actor it names and that this file re-validates. Every function begins with
 * `requireServer` — the old `app.role_claim() <> 'service_role'` refusal.
 */

const GROUNDING: ReadonlySet<string> = new Set(['passed', 'failed', 'degraded', 'not_applicable']);
const ASSURANCE: ReadonlySet<string> = new Set(['verified', 'calculated', 'estimated', 'inferred']);

/**
 * `evidence_items.same_org_ref_item`: the table an item's `ref_id` names, per `item_type`; `query`
 * names no table (its descriptor is the evidence).
 */
const ITEM_TABLE: Readonly<Record<string, OrgTable | '-'>> = {
  metric_snapshot: 'metric_snapshots', calculation_run: 'calculation_runs', ledger_entry: 'ledger_entries',
  bank_transaction: 'bank_transactions', invoice: 'invoices', period_balance: 'period_balances',
  counterparty: 'counterparties', account: 'accounts', source_document: 'source_documents',
  fiscal_period: 'fiscal_periods', alert: 'alerts', query: '-',
};

/**
 * A jsonb value as PostgreSQL would have stored it: plain JSON (so no `undefined` reaches
 * Firestore, which refuses it) — and SQL NULL for an absent key.
 */
function asJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** `(x)::integer` of a jsonb text: null stays null. */
function asInt(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) raise.invalid(`invalid input syntax for type integer: "${String(raw)}"`);
  return n;
}

/** A `bytea` from hex (`decode(x, 'hex')`): stored as lowercase hex without a `\x` prefix. */
function asHex(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const hex = String(value).toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) raise.invalid('invalid hexadecimal data');
  return hex;
}

/** An actor is named and re-validated: `p_actor` is the human the server acts for. */
function requireActor(args: Record<string, unknown>): string {
  const actor = arg.str(args, 'p_actor');
  if (!actor) raise.denied('an actor is required');
  return actor;
}

// ── Conversations and turns ────────────────────────────────────────────────────────────────────

/**
 * `api_server.ai_create_conversation(p_actor, p_org)`: a conversation opened on a member's behalf
 * by the server — the live evaluation job acting as its requester (§12; ADR-081).
 */
async function ai_create_conversation(db: Db, args: Record<string, unknown>): Promise<string> {
  requireServer(db);
  const actor = requireActor(args);
  const orgId = arg.str(args, 'p_org');
  if (!orgId || !(await hasPermissionOf(db.fs, actor, orgId, 'ai.use'))) raise.denied('ai.use required');
  const id = newId();
  await runTx(db, async (tx) => {
    tx.set(orgRow(db.fs, orgId, 'ai_conversations', id), conversationRow(id, orgId, actor, nowIso()));
  });
  return id;
}

interface ToolCallInput {
  sequence?: unknown; tool_name?: unknown; input?: unknown; authorized?: unknown; denial_reason?: unknown;
  output_hash?: unknown; output_summary?: unknown; duration_ms?: unknown; error?: unknown;
  returned_ids?: unknown; returned_hashes?: unknown;
}

interface BundleItemInput {
  item_type?: unknown; ref_id?: unknown; ref_revision_no?: unknown; query_descriptor?: unknown;
  descriptor_hash?: unknown; label?: unknown; claim?: unknown; assurance_level?: unknown;
}

/**
 * `api_server.ai_persist_turn(p_actor, p_org, p_conversation, p_user_message | p_assistant,
 * p_tool_calls, p_bundle)` — one half of a turn per call (§2 steps 4 and 11; ADR-076).
 *
 * The USER half charges the 10/min throttle and the allowance BEFORE any model is called, and
 * refuses with QUOTA when it is spent. The ASSISTANT half writes the message, every tool call and
 * the `ai_response` evidence bundle in one transaction; the bundle may cite only what a tool
 * returned in THIS call (§14.2) — the database, not the loop, refuses a citation the model invented.
 */
async function ai_persist_turn(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  requireServer(db);
  const actor = requireActor(args);
  const orgId = arg.str(args, 'p_org');
  const conversationId = arg.str(args, 'p_conversation');
  if (!orgId || !(await hasPermissionOf(db.fs, actor, orgId, 'ai.use'))) raise.denied('ai.use required');
  if (!conversationId) raise.notFound();
  const conversationRef = orgRow(db.fs, orgId, 'ai_conversations', conversationId);

  // §2 step 3 / F-C-11: the conversation belongs to (org, actor), or it does not exist.
  const ownConversation = (snap: DocumentSnapshot) => snap.exists && snap.get('user_id') === actor
    && snap.get('status') === 'active';
  if (!ownConversation(await conversationRef.get())) raise.notFound();

  const userMessage = arg.str(args, 'p_user_message');
  const assistant = args.p_assistant === undefined || args.p_assistant === null
    ? null : (args.p_assistant as Record<string, unknown>);
  if ((userMessage === null) === (assistant === null)) {
    raise.invalid('exactly one of a user message or an assistant payload is persisted per call');
  }

  if (userMessage !== null) return persistUserHalf(db, actor, orgId, conversationRef, ownConversation, userMessage);
  return persistAssistantHalf(db, actor, orgId, conversationRef, ownConversation, assistant!, args);
}

async function persistUserHalf(
  db: Db, actor: string, orgId: string, conversationRef: DocumentReference,
  ownConversation: (snap: DocumentSnapshot) => boolean, content: string,
): Promise<Record<string, unknown>> {
  await throttle(db.fs, actor, 'ai_turn', 10, 60);

  const now = new Date();
  const [daily, ceiling, usedToday] = await Promise.all([
    effectiveQuota(db.fs, orgId, 'ai_quota_daily'),
    effectiveQuota(db.fs, orgId, 'ai_token_ceiling_monthly'),
    userTurnsToday(db.fs, orgId, now),
  ]);
  if (daily !== null && usedToday >= daily) {
    raise.quota(`this organisation has used its ${daily} analyst questions for today`);
  }
  const usedMonth = await aiTokensUsedThisMonth(db.fs, orgId, now);
  if (ceiling !== null && usedMonth >= ceiling) {
    raise.quota('this organisation has reached its monthly analyst allowance');
  }

  const messageId = newId();
  await runTx(db, async (tx) => {
    if (!ownConversation(await tx.get(conversationRef))) raise.notFound();
    const at = nowIso();
    tx.set(orgRow(db.fs, orgId, 'ai_messages', messageId), {
      ...messageDefaults(messageId, orgId, conversationRef.id, at),
      role: 'user', content,
    });
    tx.update(conversationRef, { last_message_at: at, updated_at: at });
  });
  return {
    message_id: messageId,
    quota: { daily, used_today: usedToday + 1, monthly_tokens: ceiling, used_month_tokens: usedMonth },
  };
}

/** Every `ai_messages` column, at its default. */
function messageDefaults(id: string, orgId: string, conversationId: string, at: string): Record<string, unknown> {
  return {
    id, organization_id: orgId, conversation_id: conversationId, role: 'user', content: null,
    structured_response: null, prompt_version: null, model: null, input_tokens: null,
    output_tokens: null, latency_ms: null, grounding_status: 'not_applicable', grounding_report: null,
    evidence_bundle_id: null, period_context: {}, flagged: false, created_at: at,
  };
}

async function persistAssistantHalf(
  db: Db, actor: string, orgId: string, conversationRef: DocumentReference,
  ownConversation: (snap: DocumentSnapshot) => boolean, assistant: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = assistant.grounding_status === undefined || assistant.grounding_status === null
    ? null : String(assistant.grounding_status);
  if (status === null) raise.invalid('an assistant turn carries a grounding_status');
  if (!GROUNDING.has(status)) raise.invalid(`invalid input value for enum grounding_status_enum: "${status}"`);
  const tokensIn = asInt(assistant.input_tokens);
  const tokensOut = asInt(assistant.output_tokens);
  const calls = (Array.isArray(args.p_tool_calls) ? args.p_tool_calls : []) as ToolCallInput[];
  const bundle = args.p_bundle === undefined || args.p_bundle === null
    ? null : (args.p_bundle as { calculation_run_id?: unknown; items?: unknown });

  const messageId = newId();
  const at = nowIso();

  // Tool calls, in sequence. What each returned is what the bundle may cite.
  const returned = new Set<string>();
  const hashes = new Set<string>();
  const sequences = new Set<number>();
  const callRows = calls.map((call) => {
    const sequence = asInt(call.sequence);
    if (sequence === null) raise.invalid('ai_tool_calls.sequence is required');
    // ai_tool_calls_sequence_unique (message_id, sequence): the message is new, so a repeat can only
    // come from this payload.
    if (sequences.has(sequence)) {
      raise.conflict('duplicate key value violates unique constraint "ai_tool_calls_sequence_unique"');
    }
    sequences.add(sequence);
    for (const id of Array.isArray(call.returned_ids) ? call.returned_ids : []) returned.add(String(id));
    for (const h of Array.isArray(call.returned_hashes) ? call.returned_hashes : []) hashes.add(asHex(h)!);
    const id = newId();
    return {
      id, organization_id: orgId, message_id: messageId, sequence,
      tool_name: String(call.tool_name ?? ''),
      input: call.input === undefined || call.input === null ? {} : asJson(call.input),
      authorized: call.authorized === undefined || call.authorized === null ? true : Boolean(call.authorized),
      denial_reason: call.denial_reason == null ? null : String(call.denial_reason),
      output_hash: asHex(call.output_hash),
      output_summary: call.output_summary === undefined ? {} : asJson(call.output_summary),
      duration_ms: asInt(call.duration_ms),
      error: call.error == null ? null : String(call.error),
      created_at: at,
    };
  });

  // The bundle, only for a passed or degraded answer, and only from what the tools returned.
  const bundleId = bundle !== null && (status === 'passed' || status === 'degraded') ? newId() : null;
  const items = bundleId === null ? [] : (bundle!.items as BundleItemInput[] | undefined);
  if (bundleId !== null && (!Array.isArray(items) || items.length === 0)) {
    raise.invalid('an evidence bundle needs at least one item');
  }
  const runId = bundleId === null ? null : (bundle!.calculation_run_id == null ? null : String(bundle!.calculation_run_id));
  const itemRows = (items ?? []).map((item, sort) => {
    const type = String(item.item_type ?? '');
    const table = ITEM_TABLE[type];
    if (!table) raise.invalid(`invalid input value for enum evidence_item_enum: "${type}"`);
    const ref = item.ref_id === undefined || item.ref_id === null || item.ref_id === '' ? null : String(item.ref_id);
    const hash = asHex(item.descriptor_hash);
    // §14.2: bundle item ids ⊆ tool-returned ids/hashes of THIS call.
    if (type === 'query') {
      if (hash === null || !hashes.has(hash)) raise.invalid('evidence cites a descriptor no tool returned this turn');
    } else if (ref === null || !returned.has(ref)) {
      raise.invalid(`evidence cites ${ref ?? '<NULL>'} which no tool returned this turn`);
    }
    if (table === '-' && ref !== null) {
      raise.invalid('evidence_items.ref_id is set although evidence_items.item_type = query names no table');
    }
    const revision = asInt(item.ref_revision_no);
    if (revision !== null && type !== 'alert') {
      raise.conflict('new row for relation "evidence_items" violates check constraint "evidence_items_revision_only_for_alerts"');
    }
    const assurance = String(item.assurance_level ?? '');
    if (!ASSURANCE.has(assurance)) raise.invalid(`invalid input value for enum assurance_level_enum: "${assurance}"`);
    if (item.label === undefined || item.label === null) raise.invalid('evidence_items.label is required');
    const claim = item.claim === undefined || item.claim === null || item.claim === '' ? null : String(item.claim);
    return {
      table,
      row: {
        id: newId(), organization_id: orgId, bundle_id: bundleId, sort_order: sort, item_type: type,
        ref_id: ref, ref_revision_no: revision,
        query_descriptor: type === 'query' ? asJson(item.query_descriptor) : null,
        descriptor_hash: hash, label: String(item.label), claim, assurance_level: assurance, created_at: at,
      },
    };
  });

  const action = status === 'not_applicable'
    ? 'ai.refused'
    : assistant.context_changed === true || assistant.context_changed === 'true' ? 'ai.context_changed' : 'ai.answered';
  const title = assistant.title === undefined || assistant.title === null ? null : String(assistant.title).slice(0, 120);

  await runTx(db, async (tx) => {
    // Reads first: the conversation, every referenced row (same_org_ref / the run FK), the guards.
    const conversation = await tx.get(conversationRef);
    if (!ownConversation(conversation)) raise.notFound();
    if (runId !== null && !(await tx.get(orgRow(db.fs, orgId, 'calculation_runs', runId))).exists) {
      raise.invalid('evidence_bundles.calculation_run_id references a row that does not exist');
    }
    for (const { table, row } of itemRows) {
      if (table === '-' || row.ref_id === null) continue;
      if (!(await tx.get(orgRow(db.fs, orgId, table, row.ref_id))).exists) {
        raise.invalid('evidence_items.ref_id references a row that does not exist');
      }
    }
    const guards = [];
    for (const row of callRows) {
      const claim = await uniqueGuard(db.fs, { orgId }, 'ai_tool_calls_sequence_unique', [messageId, row.sequence]).read(tx);
      guards.push({ claim, id: row.id });
    }
    const audit = await prepareAudit(db, {
      organizationId: orgId, action, targetTable: 'ai_messages', targetId: messageId, before: null,
      after: { grounding_status: status, tool_calls: calls.length, input_tokens: tokensIn, output_tokens: tokensOut },
      metadata: {}, actorId: actor,
    }, tx);

    // `content` is NULL for an assistant row (`ai_messages_channel`): nothing the model wrote
    // outside `submit_answer` is stored (§14.11, F-C-08).
    tx.set(orgRow(db.fs, orgId, 'ai_messages', messageId), {
      ...messageDefaults(messageId, orgId, conversationRef.id, at),
      role: 'assistant',
      content: null,
      structured_response: asJson(assistant.structured_response),
      prompt_version: assistant.prompt_version == null ? null : String(assistant.prompt_version),
      model: assistant.model == null ? null : String(assistant.model),
      input_tokens: tokensIn,
      output_tokens: tokensOut,
      latency_ms: asInt(assistant.latency_ms),
      grounding_status: status,
      grounding_report: asJson(assistant.grounding_report),
      // §8: the period context is stored on every assistant row; a turn that failed before
      // resolution records an empty object rather than refusing the row that records the failure.
      period_context: assistant.period_context == null ? {} : asJson(assistant.period_context),
      evidence_bundle_id: bundleId,
    });
    for (const row of callRows) tx.set(orgRow(db.fs, orgId, 'ai_tool_calls', row.id), row);
    for (const { claim, id } of guards) claim.take(tx, id);
    if (bundleId !== null) {
      tx.set(orgRow(db.fs, orgId, 'evidence_bundles', bundleId), {
        id: bundleId, organization_id: orgId, kind: 'ai_response', origin_table: 'ai_messages',
        origin_id: messageId, calculation_run_id: runId, created_by_type: 'ai', created_by: actor,
        created_at: at, origin_message_id: null,
      });
      for (const { row } of itemRows) tx.set(orgRow(db.fs, orgId, 'evidence_items', row.id), row);
    }
    tx.update(conversationRef, {
      last_message_at: at,
      title: (conversation.get('title') as string | null | undefined) ?? title,
      updated_at: at,
    });
    audit.write(tx);
  });

  return { message_id: messageId, evidence_bundle_id: bundleId };
}

// ── The adviser analyst's turn record (ADR-113) ────────────────────────────────────────────────

/**
 * `api_server.portfolio_ai_begin_turn(p_actor, p_question, p_scope, p_prompt_version)`: opened
 * BEFORE the model is called. Every organisation in scope must be one the actor advises, judged by
 * the same resolver the reads use (ADR-112 §2) — a client membership, a company owner or a revoked
 * assignment resolves to no adviser role, and nothing is recorded.
 */
async function portfolio_ai_begin_turn(db: Db, args: Record<string, unknown>): Promise<string> {
  requireServer(db);
  const actor = requireActor(args);
  const scope = (arg.arr<unknown>(args, 'p_scope') ?? []).map(String);
  if (scope.length === 0) raise.invalid('a portfolio turn needs at least one organisation');
  for (const org of scope) {
    const role = await orgRoleOf(db.fs, actor, org);
    if (role !== 'super_admin' && role !== 'employee') {
      raise.denied('the actor does not advise every organisation in scope');
    }
  }

  await throttle(db.fs, actor, 'portfolio_ai', 10, 60);

  const question = arg.str(args, 'p_question') ?? '';
  if (question.length < 1 || question.length > 1000) {
    raise.conflict('new row for relation "portfolio_ai_turns" violates check constraint "portfolio_ai_turns_question_len"');
  }
  const promptVersion = arg.str(args, 'p_prompt_version');
  if (promptVersion === null) raise.invalid('portfolio_ai_turns.prompt_version is required');

  const id = newId();
  await runTx(db, async (tx) => {
    tx.set(globalRow(db.fs, 'portfolio_ai_turns', id), {
      id, user_id: actor, question, scope_organization_ids: scope, status: 'pending', answer: null,
      grounding_status: null, model: null, prompt_version: promptVersion, input_tokens: null,
      output_tokens: null, created_at: nowIso(), finished_at: null,
    });
  });
  return id;
}

/**
 * `api_server.portfolio_ai_finish_turn(p_actor, p_turn, p_answer, p_grounding, p_model,
 * p_tokens_in, p_tokens_out)`: what the server observed of the turn. Only the actor's own pending
 * turn can be finished, once.
 */
async function portfolio_ai_finish_turn(db: Db, args: Record<string, unknown>): Promise<null> {
  requireServer(db);
  const grounding = arg.str(args, 'p_grounding');
  if (grounding !== null && !GROUNDING.has(grounding)) {
    raise.invalid(`invalid input value for enum grounding_status_enum: "${grounding}"`);
  }
  const actor = arg.str(args, 'p_actor');
  const turnId = arg.str(args, 'p_turn');
  if (!turnId) raise.notFound();
  const answer = args.p_answer === undefined || args.p_answer === null ? null : asJson(args.p_answer);
  const ref = globalRow(db.fs, 'portfolio_ai_turns', turnId);
  await runTx(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('user_id') !== actor || snap.get('status') !== 'pending') raise.notFound();
    tx.update(ref, {
      status: answer === null ? 'failed' : 'answered',
      answer,
      grounding_status: grounding,
      model: arg.str(args, 'p_model'),
      input_tokens: asInt(args.p_tokens_in),
      output_tokens: asInt(args.p_tokens_out),
      finished_at: nowIso(),
    });
  });
  return null;
}

// ── Provider keys and model choice (ADR-157, ADR-163, ADR-164, ADR-170) ────────────────────────

/** `api_server.anthropic_api_key()`: the stored key in clear, for the server's model calls only. */
async function anthropic_api_key(db: Db): Promise<string | null> {
  requireServer(db);
  return readSecret(db.fs, 'anthropic_api_key');
}

/** `api_server.openai_api_key()`. */
async function openai_api_key(db: Db): Promise<string | null> {
  requireServer(db);
  return readSecret(db.fs, 'openai_api_key');
}

type Choice = { model?: unknown; effort?: unknown } | null | undefined;

/** The `ai_model` platform setting: `{ active, anthropic: {model, effort} | null, openai: … }`. */
async function modelSetting(db: Db): Promise<Record<string, unknown> | null> {
  const snap = await globalRow(db.fs, 'platform_settings', 'ai_model').get();
  const value = snap.exists ? snap.get('value') : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const hasModel = (c: Choice): c is { model: unknown; effort?: unknown } =>
  !!c && typeof c === 'object' && !Array.isArray(c) && c.model !== null && c.model !== undefined;

const choiceOf = (provider: 'anthropic' | 'openai', c: { model: unknown; effort?: unknown }) => ({
  provider, model: c.model, effort: c.effort ?? null,
});

/**
 * `api_server.ai_model()`: the ACTIVE provider's choice — OpenAI's when it is active and has a model,
 * else Anthropic's when that has one, else null (the server's configuration applies).
 */
async function ai_model(db: Db): Promise<Record<string, unknown> | null> {
  requireServer(db);
  const value = await modelSetting(db);
  if (!value) return null;
  const openai = value.openai as Choice;
  const anthropic = value.anthropic as Choice;
  if (value.active === 'openai' && hasModel(openai)) return choiceOf('openai', openai);
  if (hasModel(anthropic)) return choiceOf('anthropic', anthropic);
  return null;
}

/** `api_server.ai_model_for(p_provider)`: ONE provider's own choice, whichever is active (ADR-170). */
async function ai_model_for(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  requireServer(db);
  const provider = arg.str(args, 'p_provider');
  if (provider !== 'anthropic' && provider !== 'openai') raise.invalid('the provider is anthropic or openai');
  const value = await modelSetting(db);
  const choice = value?.[provider] as Choice;
  return hasModel(choice) ? choiceOf(provider, choice) : null;
}

/** `api_server.*` functions of this area, ported from PostgreSQL (FIRESTORE_DATA_MODEL.md §8). */
export const functions: DbFunctions = {
  ai_create_conversation,
  ai_persist_turn,
  portfolio_ai_begin_turn,
  portfolio_ai_finish_turn,
  anthropic_api_key,
  openai_api_key,
  ai_model,
  ai_model_for,
};
