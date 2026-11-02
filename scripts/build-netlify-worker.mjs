// Bundles the job worker (src/worker/netlify-jobs.ts) into the Netlify background function
// netlify/functions/jobs-worker-background.mjs (ADR-183). App code is bundled; npm packages stay
// external and are packed by Netlify. `server-only` is replaced by an empty module: this bundle runs
// only on the server, which is the guarantee that package exists to give.
import { build } from 'esbuild';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
// npm packages stay external, except `next`: its `next/headers`-style entry points resolve only
// inside Next's own bundler, so the few parts the app's server code imports are bundled in.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name !== 'next')
  .flatMap((name) => [name, `${name}/*`]);

const serverOnly = {
  name: 'server-only',
  setup(b) {
    b.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
  },
};

await build({
  entryPoints: [path.join(root, 'src/worker/netlify-jobs.ts')],
  outfile: path.join(root, 'netlify/functions/jobs-worker-background.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external,
  tsconfig: path.join(root, 'tsconfig.json'),
  plugins: [serverOnly],
  // Next's bundled parts are CommonJS and `require` their peers (react): give the ES module a require.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
process.stdout.write('job worker: netlify/functions/jobs-worker-background.mjs\n');
