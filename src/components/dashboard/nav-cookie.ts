/**
 * The browser-session cookie that keeps the sidebar shown (`apx_nav=shown`; owner, 2026-10-14). A
 * plain module so the server shell and the client frame read the same name — a constant exported
 * from a 'use client' file reaches a server component as a client reference, not as its value.
 */
export const NAV_COOKIE = 'apx_nav';
