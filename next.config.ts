import type { NextConfig } from 'next';

// Security headers per SECURITY_MODEL.md §10. CSP uses a nonce injected by middleware.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Server Actions are only callable from our own origins (CSRF defence, SECURITY_MODEL.md §10).
    serverActions: { allowedOrigins: ['localhost:3000'] },
    /*
     * `forbidden()` and the `forbidden.tsx` convention (ADR-091). ROUTE_ARCHITECTURE.md §11 asks for
     * HTTP 403 with the §7.4 denied state on a page a role may not view, and this is the only way a
     * Server Component can set that status. It is flagged experimental by Next, which is a statement
     * about the API's stability and not about what it renders; the alternative was to keep answering
     * 404, or 500 through the error boundary, for an authorisation outcome the spec names exactly.
     */
    authInterrupts: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
