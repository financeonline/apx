import { callApi } from '@/core/db/api-rpc';
import { db } from '@/db/firestore';
import type { Db } from '@/db/types';

/**
 * Runs one of the app's own `api.*` functions as a signed-in person, on the LOCAL emulators, and
 * prints its result as JSON on the last line. The sample-data runs use it (`callApiAs` in
 * firestore.ts) for the records no screen of theirs offers, so those writes keep the app's checks,
 * unique keys and audit events instead of being written around them.
 *
 *   node --conditions=react-server --import tsx scripts/sample-data/call-api.ts <uid> <email> <fn> '<json args>'
 *
 * `--conditions=react-server` makes `server-only` (imported throughout src/db) resolve to its no-op
 * server build; `tsx` reads tsconfig.json for the `@/` paths.
 */

async function main(): Promise<void> {
  const [uid, email, fn, json] = process.argv.slice(2);
  if (!uid || !fn) throw new Error('usage: call-api.ts <uid> <email> <fn> <json args>');
  const project = process.env.FIREBASE_PROJECT_ID ?? 'demo-apx';
  if (!process.env.FIRESTORE_EMULATOR_HOST || !project.startsWith('demo-')) {
    throw new Error(`refusing: the sample data is for the local emulators only (project ${project}, FIRESTORE_EMULATOR_HOST ${process.env.FIRESTORE_EMULATOR_HOST ?? 'unset'})`);
  }
  const handle: Db = {
    fs: db(),
    actor: { kind: 'user', userId: uid, email: email || null, authTime: Math.floor(Date.now() / 1000) },
    meta: { requestId: null },
  };
  const result = await callApi(handle, fn, JSON.parse(json ?? '{}') as Record<string, unknown>);
  process.stdout.write(`\n${JSON.stringify(result ?? null)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
