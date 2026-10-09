import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';

test('personal build has no external analytics or error-reporting runtime graph', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'wm-personal-telemetry-'));
  const keys = ['SENTRY_AUTH_TOKEN', 'SENTRY_RELEASE', 'VERCEL_ENV'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.SENTRY_AUTH_TOKEN = '';
  process.env.SENTRY_RELEASE = '';
  process.env.VERCEL_ENV = 'development';
  const modules = new Set();
  try {
    await build({
      configFile: path.resolve('vite.config.ts'),
      logLevel: 'error',
      build: { outDir, emptyOutDir: true },
      plugins: [{
        name: 'personal-telemetry-runtime-graph',
        generateBundle() {
          for (const id of this.getModuleIds()) modules.add(id.replaceAll('\\', '/'));
        },
      }],
    });
    assert.ok(modules.size > 100, 'Inspect the actual application graph, not an empty fixture.');
    const externalTelemetry = [...modules].filter(id =>
      /\/node_modules\/(?:@sentry\/|@sentry-internal\/|@vercel\/analytics\/|web-vitals\/)/.test(id)
      || /\/src\/(?:bootstrap\/(?:sentry-(?:init|defer)|debugbear-rum|cls-report|inp-report|lcp-report)|services\/(?:analytics|analytics-collector-transport))\.ts(?:$|\?)/.test(id));
    assert.deepEqual(externalTelemetry, []);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(outDir, { recursive: true, force: true });
  }
});
