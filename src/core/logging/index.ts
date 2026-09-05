import { createHash } from 'node:crypto';

/**
 * Structured logging (SERVICE_ARCHITECTURE.md §9). Never logs amounts, descriptions or document
 * text; user ids are hashed in production. Audit is a product feature stored in Postgres and is a
 * different thing from these operational logs.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  requestId?: string;
  organizationId?: string | null;
  userId?: string | null;
  route?: string;
  service?: string;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
}

const isProduction = process.env.NODE_ENV === 'production';

function hashUser(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const payload: Record<string, unknown> = {
    level,
    message,
    time: new Date().toISOString(),
    ...fields,
  };
  if (typeof fields.userId === 'string' && isProduction) {
    payload.userId = hashUser(fields.userId);
  }
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else console.warn(line);
}

export const log = {
  debug: (m: string, f?: LogFields) => {
    if (!isProduction) emit('debug', m, f);
  },
  info: (m: string, f?: LogFields) => emit('info', m, f),
  warn: (m: string, f?: LogFields) => emit('warn', m, f),
  error: (m: string, f?: LogFields) => emit('error', m, f),
};

export function newRequestId(): string {
  return crypto.randomUUID();
}
