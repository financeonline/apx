import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Public liveness probe. Reveals nothing about the database (SECURITY_MODEL.md §15). */
export function GET() {
  return NextResponse.json({ ok: true, version: process.env.npm_package_version ?? '0.1.0' });
}
