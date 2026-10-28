import 'server-only';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';

/**
 * The one Firebase Admin app (FIRESTORE_DATA_MODEL.md §1).
 *
 * The Admin SDK is the ONLY way APX reaches Firestore, Auth and Storage: the security rules refuse
 * every client SDK request (firebase/firestore.rules), so the checks in `src/db` are the tenant
 * boundary, as row-level security was on PostgreSQL.
 *
 * Locally the project is `demo-apx` and the SDK talks to the emulators named by
 * FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST. A `demo-`
 * project cannot reach Google's servers at all. Connecting the real project later means setting
 * FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT (the service account's JSON key) — or
 * GOOGLE_APPLICATION_CREDENTIALS — and unsetting the emulator hosts; no code change.
 *
 * Without an emulator host and without credentials there is nothing to connect to, and the SDK would
 * wait on Google's metadata server instead of failing: so that case fails at once, loudly.
 */

const APP_NAME = 'apx';

function projectId(): string {
  return process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? 'demo-apx';
}

export function storageBucketName(): string {
  return process.env.FIREBASE_STORAGE_BUCKET ?? `${projectId()}.appspot.com`;
}

function app(): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!usingEmulators() && !serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Firebase is not configured: set the emulator hosts, or FIREBASE_SERVICE_ACCOUNT for a real project');
  }
  return initializeApp({
    projectId: projectId(),
    storageBucket: storageBucketName(),
    ...(serviceAccount && !usingEmulators() ? { credential: cert(JSON.parse(serviceAccount)) } : {}),
  }, APP_NAME);
}

let firestore: Firestore | null = null;

export function db(): Firestore {
  if (firestore) return firestore;
  firestore = getFirestore(app());
  try {
    // An `undefined` field is a caller's bug: refuse it rather than store or drop it silently.
    firestore.settings({ ignoreUndefinedProperties: false });
  } catch {
    // Already configured: a dev-server module reload hands back the same instance.
  }
  return firestore;
}

export function auth(): Auth {
  return getAuth(app());
}

export function storage(): Storage {
  return getStorage(app());
}

/** True when this process talks to the local emulators rather than a real Firebase project. */
export function usingEmulators(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}
