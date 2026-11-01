/**
 * The prototype's icon set (`app.js#icons`), verbatim: 24×24 stroke paths drawn by `svg.icon`.
 * Static markup, so it is set with dangerouslySetInnerHTML — no reader input ever reaches it.
 */
export const ICON_PATHS = {
  workflow: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 9 1 1 2-2m3 1h5m-11 6 1 1 2-2m3 1h5"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  feedback: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z"/><path d="M7 9h10M7 13h7"/>',
  chart: '<path d="M4 19V5m0 14h16M8 15l4-5 4 2 4-7"/>',
  bank: '<path d="m3 8 9-5 9 5M4 10h16M6 10v8m6-8v8m6-8v8M3 21h18"/>',
  capture: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h3"/>',
  forecast: '<path d="M3 19h18M5 15l4-5 4 3 7-9m-5 0h5v5"/>',
  client: '<circle cx="12" cy="8" r="3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/>',
  analyst: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-2a6 6 0 0 1 9-5m3 2 2 2 4-5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .5-1.5 1-1.5 2m0 3h.01"/>',
  layers: '<path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  sliders: '<path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18m-12 0v10"/>',
  pie: '<path d="M12 3v9h9a9 9 0 0 0-9-9Z"/><path d="M8 4a9 9 0 1 0 12 12"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7 0v4m-2-2h4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 4 1-1a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  refresh: '<path d="M20 9a8 8 0 0 0-14-4L3 8m0-5v5h5m-4 7a8 8 0 0 0 14 4l3-3m0 5v-5h-5"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 13h8m-8 4h6"/>',
  check: '<path d="m5 12 5 5L20 6"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;
