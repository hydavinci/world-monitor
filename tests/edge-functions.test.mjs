import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listTrackedApiSourceFiles } from '../scripts/check-edge-function-bundles.mjs';
import { retiredRouteResponse } from '../api/_retired-routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const apiDir = join(root, 'api');
const sharedDir = join(root, 'shared');
const scriptsSharedDir = join(root, 'scripts', 'shared');

const trackedApiSources = listTrackedApiSourceFiles(root);

// Both api-wide guards below register one `it()` PER DISCOVERED FILE, so an
// empty discovery makes them emit zero assertions and this suite reports green
// while checking nothing — a `node:` import smuggled into an edge function
// would ship unnoticed. `git ls-files` exits 0 with empty output whenever the
// pathspec matches nothing, so that is reachable; the previous readdirSync
// implementation threw instead. Fail closed, mirroring the checker's own
// zero-entry guard.
describe('tracked api/ discovery', () => {
  it('finds at least one tracked api/ source', () => {
    assert.ok(
      trackedApiSources.length > 0,
      'listTrackedApiSourceFiles returned nothing — the guards below would pass vacuously',
    );
  });
});

// Legacy JS entrypoints at api/ and api/oauth/ have stricter isolation rules.
const allEdgeFunctions = trackedApiSources
  .filter((file) => file.endsWith('.js'))
  .filter((file) => ['api', 'api/oauth'].includes(dirname(file)))
  .map((file) => ({ name: file.slice('api/'.length), path: join(root, file) }));

// All tracked .js and .ts files under api/ are used for node: built-in checks.
// Note: .ts edge functions are intentionally excluded from the
// module-isolation describe below because Vercel bundles them at build time, so
// imports from '../server/' are valid. The node: built-in check still applies
// regardless of depth, since Vercel Edge Runtime rejects node: imports at runtime.
const allApiFiles = trackedApiSources.map((file) => ({
  name: file.slice('api/'.length),
  path: join(root, file),
}));

describe('scripts/shared/ stays in sync with shared/', () => {
  // Historical scope: .json (data) + .cjs (helpers).
  // Explicit additions (must be mirrored): edge-safe modules the cron consumes
  // (e.g. brief-llm-core.js + its .d.ts). Other .js files in shared/ are
  // client-only and intentionally NOT mirrored — grow this list only when a
  // new file is imported from `scripts/`.
  const explicitMirroredFiles = new Set([
    'brief-llm-core.js',
    'brief-llm-core.d.ts',
    'correlation-runtime-mode.js',
    'physical-divergence-contract.js',
    'physical-divergence-contract.d.ts',
    'physical-divergence-staleness.js',
    'physical-divergence-staleness.d.ts',
    // #6428: publisher-family resolution for corroboration counting, consumed
    // by scripts/_clustering.mjs (Railway rootDirectory=scripts) and by the
    // edge digest. Must stay byte-identical.
    'publisher-families.js',
    'publisher-families.d.ts',
    // U6/U7: pure URL classifier consumed by the brief filter (edge) AND
    // by the audit script under scripts/. Must stay byte-identical.
    'url-classifier.js',
    // Railway seed-wb-indicators.mjs writes the same v2 keys the Edge RPC reads.
    'world-bank-rpc-cache.js',
  ]);
  // The attribution manifest is canonical at shared/ and is consumed by
  // repository-rooted build tooling. It is not a scripts-runtime input, so a
  // second committed copy would recreate the shared-file merge hotspot.
  const canonicalOnlyFiles = new Set(['source-attribution-manifest.json']);
  const sharedFiles = readdirSync(sharedDir).filter(
    (f) => !canonicalOnlyFiles.has(f)
      && (f.endsWith('.json') || f.endsWith('.cjs') || explicitMirroredFiles.has(f)),
  );
  for (const file of sharedFiles) {
    it(`scripts/shared/${file} matches shared/${file}`, () => {
      const srcPath = join(scriptsSharedDir, file);
      assert.ok(existsSync(srcPath), `scripts/shared/${file} is missing — run: cp shared/${file} scripts/shared/`);
      const original = readFileSync(join(sharedDir, file), 'utf8');
      const copy = readFileSync(srcPath, 'utf8');
      assert.strictEqual(copy, original, `scripts/shared/${file} is out of sync with shared/${file} — run: cp shared/${file} scripts/shared/`);
    });
  }
});

describe('Edge Function shared helpers resolve', () => {
  it('_rss-allowed-domains.js re-exports shared domain list', async () => {
    const mod = await import(pathToFileURL(join(apiDir, '_rss-allowed-domains.js')).href);
    const domains = mod.default;
    assert.ok(Array.isArray(domains), 'Expected default export to be an array');
    // Content parity, not just a smoke check. api/_rss-allowed-domains.js is a
    // hand-maintained literal mirror of the shared JSON (Vercel edge esbuild
    // cannot import JSON via import attributes, and api/*.js cannot import from
    // ../shared), so this assertion is the only thing stopping it drifting from
    // the source of truth. A domain added to shared/ but missed here 403s in the
    // edge proxy while every other consumer works — the same silent-drift class
    // the scripts/shared/ check above already guards against.
    const shared = JSON.parse(readFileSync(join(sharedDir, 'rss-allowed-domains.json'), 'utf8'));
    assert.deepStrictEqual(
      domains,
      shared,
      'api/_rss-allowed-domains.js is out of sync with shared/rss-allowed-domains.json — ' +
        'update the literal array in api/_rss-allowed-domains.js to match',
    );
  });
});

describe('Edge Function no node: built-ins', () => {
  for (const { name, path } of allApiFiles) {
    it(`${name} does not import node: built-ins (unsupported in Vercel Edge Runtime)`, () => {
      const src = readFileSync(path, 'utf-8');
      const match = src.match(/from\s+['"]node:(\w+)['"]/);
      assert.ok(
        !match,
        `${name}: imports node:${match?.[1]} — Vercel Edge Runtime does not support node: built-in modules. Use an edge-compatible alternative.`,
      );
    });
  }
});

// AGENTS.md: legacy JS entries share code only through `_*.js` helpers or
// packages. Importing another route entry couples two deployables and bundles
// the whole sibling handler (#8305 briefly had authorize.js import register.js).
describe('Legacy JS entries import only _-prefixed relative modules', () => {
  for (const { name, path } of allEdgeFunctions) {
    it(`${name} imports no sibling route entry`, () => {
      const src = readFileSync(path, 'utf-8');
      const specs = [...src.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
      const routes = specs.filter((spec) => !spec.split('/').pop().startsWith('_'));
      assert.deepEqual(routes, [], `${name}: move shared code into a _-prefixed helper`);
    });
  }
});

// The legacy api/*.js allowlist that previously lived here was replaced by
// api/api-route-exceptions.json + scripts/enforce-sebuf-api-contract.mjs (see
// docs/adding-endpoints.mdx). The new check covers nested paths and .ts files,
// which this block missed.

describe('reverse-geocode Redis write', () => {
  const geocodePath = join(apiDir, 'reverse-geocode.js');

  it('uses ctx.waitUntil for Redis write (non-blocking, survives isolate teardown)', () => {
    const src = readFileSync(geocodePath, 'utf-8');
    assert.ok(
      src.includes('ctx.waitUntil('),
      'reverse-geocode.js: Redis cache write must use ctx.waitUntil() so the response is not blocked by the write',
    );
    assert.ok(
      !src.includes('await fetch(redisUrl'),
      'reverse-geocode.js: Redis write must not be awaited before returning the response',
    );
  });

  it('bounds the Redis write with AbortSignal.timeout', () => {
    const src = readFileSync(geocodePath, 'utf-8');
    assert.ok(
      src.includes('AbortSignal.timeout'),
      'reverse-geocode.js: Redis write must have AbortSignal.timeout to bound slow writes',
    );
  });
});

describe('removed account connectors fail closed', () => {
  for (const path of ['/api/oauth/authorize', '/api/slack/oauth/start', '/api/slack/oauth/callback', '/api/discord/oauth/callback']) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      it(`${method} ${path} denies without an OAuth redirect or public cache`, async () => {
        const response = retiredRouteResponse(new Request(`https://example.com${path}`, { method }), new Headers());
        assert.equal(response?.status, 403);
        assert.equal((await response.json()).error, 'feature_removed');
        assert.match(response.headers.get('cache-control'), /private.*no-store/);
        assert.equal(response.headers.get('location'), null);
      });
    }
  }
});

describe('vercel.json CSP: retired callbacks have no inline-script exceptions', () => {
  const vercelJson = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf-8'));

  it('does not grant retired Slack or Discord callback pages special script permissions', () => {
    for (const path of ['/api/slack/oauth/callback', '/api/discord/oauth/callback']) {
      assert.ok(!vercelJson.headers?.some((rule) => rule.source === path), `${path} must inherit the ordinary policy`);
    }
  });

  it('retains the ordinary response security headers', () => {
    const headers = vercelJson.headers ?? [];
    const globalIdx = headers.findIndex((rule) => rule.headers?.some(
      (header) => header.key === 'X-Frame-Options' && header.value === 'SAMEORIGIN',
    ));
    assert.ok(globalIdx !== -1, 'vercel.json: global CSP rule not found');
  });
});

describe('Edge Function module isolation', () => {
  for (const { name, path } of allEdgeFunctions) {
    it(`${name} does not import from ../server/ (Edge Functions cannot resolve cross-directory TS)`, () => {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !src.includes("from '../server/"),
        `${name}: imports from ../server/ — Vercel Edge Functions cannot resolve cross-directory TS imports. Inline the code or move to a same-directory .js helper.`,
      );
    });

    it(`${name} does not import from ../src/ (Edge Functions cannot resolve TS aliases)`, () => {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !src.includes("from '../src/"),
        `${name}: imports from ../src/ — Vercel Edge Functions cannot resolve @/ aliases or cross-directory TS. Inline the code instead.`,
      );
    });
  }
});

// Scenario endpoints (run / status / templates) were migrated from literal-filename
// edge functions to ScenarioService RPCs in PR #3207 commit 7. See
// tests/scenario-handler.test.mjs for the handler-level coverage that preserves
// the security invariants (405/POST guard via sebuf service-config, scenarioId +
// iso2 validation, JOB_ID_RE path-traversal guard, per-IP 10/min rate limit via
// gateway, queue-depth backpressure, AbortSignal.timeout on Redis pipelines).
