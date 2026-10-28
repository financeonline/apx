import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { nowIso } from '../schema';
import { usingEmulators } from '../firestore';

/**
 * The platform's secrets (the Anthropic and OpenAI API keys) — the port of Supabase Vault
 * (`vault.secrets`, `vault.decrypted_secrets`).
 *
 * One document per secret in the top-level `platform_secrets` collection, keyed by its name, holding
 * the value encrypted with AES-256-GCM under `APX_SECRETS_KEY` (32 random bytes, base64) and a
 * `description` ("ending abcd") that the status pages read without decrypting. No user read reaches
 * this collection: it has no policy in `src/db/rls.ts`, and only `api_server.*` decrypts.
 *
 * On the emulators a fixed development key is used when `APX_SECRETS_KEY` is unset, so local work
 * needs no setup; anywhere else a missing key is a configuration error, never a silent default.
 */
export const SECRETS_COLLECTION = 'platform_secrets';

function key(): Buffer {
  const raw = process.env.APX_SECRETS_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('APX_SECRETS_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  if (usingEmulators()) return createHash('sha256').update('apx-local-emulator-secrets').digest();
  throw new Error('APX_SECRETS_KEY is not set');
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

function decrypt(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8');
}

export interface SecretStatus {
  readonly configured: boolean;
  readonly description: string | null;
  readonly updated_at: string | null;
}

/** `vault.create_secret` / `vault.update_secret`, inside the caller's transaction (write only). */
export function writeSecret(tx: Transaction, fs: Firestore, name: string, value: string, description: string): void {
  tx.set(fs.collection(SECRETS_COLLECTION).doc(name), {
    name, value: encrypt(value), description, updated_at: nowIso(),
  });
}

export function deleteSecret(tx: Transaction, fs: Firestore, name: string): void {
  tx.delete(fs.collection(SECRETS_COLLECTION).doc(name));
}

/** The status a settings page shows: whether it is set, its description, when it changed. */
export async function secretStatus(fs: Firestore, name: string, tx?: Transaction): Promise<SecretStatus> {
  const ref = fs.collection(SECRETS_COLLECTION).doc(name);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return { configured: false, description: null, updated_at: null };
  return { configured: true, description: String(snap.get('description') ?? ''), updated_at: String(snap.get('updated_at')) };
}

/** `vault.decrypted_secrets`: the value, for `api_server.*` only. Null when unset. */
export async function readSecret(fs: Firestore, name: string): Promise<string | null> {
  const snap = await fs.collection(SECRETS_COLLECTION).doc(name).get();
  if (!snap.exists) return null;
  return decrypt(String(snap.get('value')));
}
