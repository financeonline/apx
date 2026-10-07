import 'server-only';
import { headers } from 'next/headers';

/**
 * The origin the current request arrived at (`https://host`), for links that leave the app — an
 * invitation to share, or where an emailed sign-up link should land. Behind a proxy the forwarded
 * headers win; locally it is the dev server's own host.
 */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const forwardedProto = h.get('x-forwarded-proto');
  const proto = forwardedProto ?? (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https');
  return `${proto.split(',')[0]!.trim()}://${host.split(',')[0]!.trim()}`;
}
