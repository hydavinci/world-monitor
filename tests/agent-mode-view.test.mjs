import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const view = JSON.parse(readFileSync(join(ROOT, 'public/agent-view.json'), 'utf-8'));
const serverCard = JSON.parse(
  readFileSync(join(ROOT, 'public/.well-known/mcp/docs-server-card.json'), 'utf-8'),
);
const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'));
const productFacts = JSON.parse(readFileSync(join(ROOT, 'public/product-facts.json'), 'utf-8'));

// Guards for the ?mode=agent machine-readable homepage view (orank Identity
// `agent-mode-view` bonus): the static JSON must stay in parity with the real
// discovery artifacts it summarizes, and the query-gated rewrite must fire
// before the public dashboard fallback.
describe('agent-mode view (/?mode=agent)', () => {
  it('agent-view.json carries the machine-readable essentials', () => {
    assert.equal(view.kind, 'agent-view');
    for (const key of ['product', 'url', 'description', 'endpoints', 'authentication', 'rateLimits', 'documentation', 'capabilities', 'discovery']) {
      assert.ok(key in view, `agent-view.json missing ${key}`);
    }
    assert.ok(Array.isArray(view.capabilities) && view.capabilities.length >= 5);
    assert.equal(view.endpoints.webMcp.url, 'https://www.worldmonitor.app/dashboard');
    assert.match(view.endpoints.webMcp.note, /modelContext/);
    assert.equal(view.authentication.apiKey, undefined, 'retired account keys must not be advertised');
    assert.equal(view.authentication.oauth2, undefined, 'retired account OAuth must not be advertised');
    assert.match(view.authentication.summary, /Authentication/);
    assert.match(view.authentication.summary, /anonymous|no auth/i);
  });

  it('advertises the sandbox, quickstart, and docs MCP endpoints', () => {
    assert.equal(view.endpoints.sandbox.url, 'https://www.worldmonitor.app/sandbox/index.json');
    assert.doesNotThrow(
      () => readFileSync(join(ROOT, 'public/sandbox/index.json')),
      'sandbox index advertised but public/sandbox/index.json is missing',
    );
    assert.equal(view.endpoints.docsMcp.url, 'https://www.worldmonitor.app/docs/mcp');
    assert.ok(view.quickstart && typeof view.quickstart === 'object');
    for (const key of ['sandbox', 'rest', 'mcp']) {
      assert.match(view.quickstart[key], /^curl /, `quickstart.${key} must be a runnable curl line`);
    }
    assert.match(view.quickstart.mcp, /https:\/\/www\.worldmonitor\.app\/docs\/mcp(?:\s|$)/);
    // The sandbox quickstart must reference a fixture that actually ships.
    assert.doesNotThrow(() => readFileSync(join(ROOT, 'public/sandbox/get-resilience-score.json')));
  });

  it('advertises every official SDK ecosystem with an install command', () => {
    const sdks = view.endpoints.sdks;
    assert.deepEqual(
      Object.keys(sdks).filter((k) => !['guide', 'note'].includes(k)).sort(),
      ['go', 'javascript', 'python', 'ruby'],
    );
    assert.equal(sdks.python.install, 'pip install worldmonitor-sdk');
    assert.match(sdks.go.install, /^go get github\.com\/koala73\/worldmonitor\/sdk\/go$/);
    for (const key of ['javascript', 'python', 'ruby', 'go']) {
      assert.match(sdks[key].url, /^https:\/\//, `sdks.${key}.url must be a registry URL`);
    }
    // The SDK sources these advertise must exist in-repo.
    for (const dir of ['sdk/python', 'sdk/ruby', 'sdk/go']) {
      assert.doesNotThrow(() => readFileSync(join(ROOT, dir, 'README.md')), `${dir} must exist`);
    }
  });

  it('the public dashboard advertises its machine-readable alternate views', () => {
    const alternateLinks = [
      ['application/json', 'https://www.worldmonitor.app/?mode=agent'],
      ['text/plain', '/llms.txt'],
      ['text/markdown', '/index.md'],
      ['text/markdown', '/world-monitor.md'],
    ];
    for (const path of ['index.html']) {
      const html = readFileSync(join(ROOT, path), 'utf-8');
      for (const [type, href] of alternateLinks) {
        assert.ok(
          html.includes(`<link rel="alternate" type="${type}" href="${href}"`),
          `${path} must advertise ${href} via <link rel="alternate">`,
        );
      }
    }
  });

  it('the homepage markdown mirror gives agents useful follow-on context', () => {
    const markdown = readFileSync(join(ROOT, 'public/home.md'), 'utf-8');
    const wordCount = markdown.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;

    assert.ok(wordCount >= 550, `public/home.md is too thin for agents (${wordCount} words)`);
    for (const heading of [
      '## What World Monitor answers',
      '## How the correlation surface works',
      '## Sources, provenance, and freshness',
      '## Access and plans',
      '## For AI agents',
      '## Trust boundaries',
    ]) {
      assert.ok(markdown.includes(heading), `public/home.md is missing ${heading}`);
    }
    assert.match(markdown, /\[Data source catalog\]\(https:\/\/www\.worldmonitor\.app\/sources\/\)/);
  });

  it('advertises the schemamap and every section llms.txt', () => {
    assert.equal(view.discovery.schemamap, 'https://www.worldmonitor.app/schemamap.xml');
    assert.doesNotThrow(() => readFileSync(join(ROOT, 'public/schemamap.xml')));
    const sections = view.discovery.sectionLlmsTxt;
    assert.deepEqual(Object.keys(sections).sort(), ['api', 'blog', 'developers', 'docs']);
    const trackedSectionFiles = {
      api: 'public/api/llms.txt',
      developers: 'public/developers/llms.txt',
      blog: 'blog-site/src/pages/llms.txt.ts', // generated at /blog/llms.txt by Astro
    };
    for (const [section, path] of Object.entries(trackedSectionFiles)) {
      assert.doesNotThrow(
        () => readFileSync(join(ROOT, path)),
        `${path} must exist for discovery.sectionLlmsTxt.${section}`,
      );
    }
    // /docs/llms.txt is Mintlify-served; pin the URL so a docs-host move shows up here.
    assert.equal(sections.docs, 'https://www.worldmonitor.app/docs/llms.txt');
  });

  it('stays in parity with the public docs MCP card without announcing retired product transports', () => {
    assert.equal(view.endpoints.docsMcp.url, serverCard.url);
    assert.equal(view.endpoints.docsMcp.serverCard, 'https://www.worldmonitor.app/.well-known/mcp/docs-server-card.json');
    assert.equal(view.endpoints.docsMcp.tools, undefined, 'agent-view must not carry a hand-maintained tool total');
    assert.ok(serverCard.tools.length > 0, 'the linked documentation server card must expose tools');
    assert.equal(serverCard.authentication, 'none');
    for (const endpoint of ['mcp', 'a2a', 'nlweb']) {
      assert.equal(view.endpoints[endpoint], undefined, `${endpoint} is retired, not browser WebMCP`);
    }
  });

  it('points agents at derived tool and locale inventories instead of orphaned totals', () => {
    assert.equal(view.endpoints.docsMcp.tools, undefined);
    const llmsFull = readFileSync(join(ROOT, 'public/llms-full.txt'), 'utf-8');
    assert.match(llmsFull, /product-facts\.json.*capabilities\.localeCodes/);
    assert.ok(productFacts.capabilities.localeCodes.length > 0);
    assert.equal(
      productFacts.capabilities.localeCodes.length,
      productFacts.capabilities.locales,
      'the agent-readable locale list must match the derived locale count',
    );
  });

  it('vercel.json serves it for /?mode=agent ahead of the public dashboard rewrite', () => {
    const rewrites = vercelConfig.rewrites;
    const agentIdx = rewrites.findIndex(
      (r) =>
        r.source === '/' &&
        Array.isArray(r.has) &&
        r.has.some((h) => h.type === 'query' && h.key === 'mode' && h.value === 'agent') &&
        r.destination === '/agent-view.json',
    );
    const dashboardIdx = rewrites.findIndex(
      (r) => r.source === '/' && r.destination === '/dashboard.html',
    );
    assert.ok(agentIdx >= 0, 'missing /?mode=agent rewrite to /agent-view.json');
    assert.ok(dashboardIdx >= 0, 'public dashboard rewrite missing');
    assert.ok(agentIdx < dashboardIdx, '?mode=agent rewrite must precede the dashboard rewrite (first match wins)');
    assert.ok(!rewrites.some((r) => /\/pro(?:\/|$)/.test(r.destination)), 'rewrites must not restore the retired marketing build');
  });

  it('every discovery URL it advertises resolves to a tracked file or a live rewrite', () => {
    // Static, repo-tracked surfaces — a typo here ships a dead link to agents.
    // Host split is the Cloudflare apex-exemption list (ARCHITECTURE.md §2):
    // `/.well-known/*` is served on the apex, everything else 301s to www, and
    // publishing the redirecting form costs every agent a wasted fetch (#7660).
    const trackedPaths = {
      'https://www.worldmonitor.app/plugin.json': 'public/plugin.json',
      'https://worldmonitor.app/.well-known/agent-skills/index.json':
        'public/.well-known/agent-skills/index.json',
      'https://worldmonitor.app/.well-known/api-catalog': 'public/.well-known/api-catalog',
      'https://worldmonitor.app/.well-known/ai-catalog.json': 'public/.well-known/ai-catalog.json',
      'https://www.worldmonitor.app/product-facts.json': 'public/product-facts.json',
      'https://www.worldmonitor.app/llms.txt': 'public/llms.txt',
    };
    for (const [url, path] of Object.entries(trackedPaths)) {
      assert.equal(
        Object.values(view.discovery).includes(url),
        true,
        `discovery must advertise ${url}`,
      );
      assert.doesNotThrow(() => readFileSync(join(ROOT, path)), `${path} must exist for ${url}`);
    }
    // /index.md and negotiated Markdown share the retained identity document.
    const mdRewrite = vercelConfig.rewrites.find((r) => r.source === '/index.md');
    assert.ok(mdRewrite, 'markdownHomepage advertised but /index.md rewrite is gone');
    assert.equal(mdRewrite.destination, '/world-monitor.md');
    assert.doesNotThrow(() => readFileSync(join(ROOT, 'public/world-monitor.md')));
  });

  it('public agent announcements do not direct users to retired product or account routes', () => {
    for (const path of ['public/agent-view.json', 'public/home.md', 'public/world-monitor.md', 'public/llms-full.txt']) {
      assert.doesNotMatch(
        readFileSync(join(ROOT, path), 'utf-8'),
        /https:\/\/(?:www\.)?worldmonitor\.app\/(?:mcp|pro|pricing|oauth|a2a|ask)(?:[\/?#\s"'`)]|$)/i,
        `${path} must not announce retired routes; /docs/mcp and browser WebMCP remain public`,
      );
    }
    assert.doesNotMatch(
      readFileSync(join(ROOT, 'public/llms-full.txt'), 'utf-8'),
      /\bget_(?:country_risk|world_brief) MCP tool\b|\bPro-only\b|\bnormal Pro\/API auth path\b|World Monitor API Starter at \$99\.99/i,
      'inlined upstream methodology must not advertise retired fork interfaces or plans',
    );
  });

  it('the extended agent document matches its retained public generator', async () => {
    const { buildLlmsFullText } = await import('../scripts/build-llms-full.mjs');
    assert.equal(
      readFileSync(join(ROOT, 'public/llms-full.txt'), 'utf-8'),
      buildLlmsFullText({ rootDir: ROOT }),
      'public/llms-full.txt must retain the public generator output, including source attribution',
    );
  });
});
