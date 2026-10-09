import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOpenApiByteSize } from '../scripts/build-openapi-json.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const LLMS_FILES = ['public/llms.txt', 'public/llms-full.txt', 'public/api/llms.txt'];
const LLMS_TEXTS = new Map(
  LLMS_FILES.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf-8')]),
);
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
const OPENAPI_BYTES = statSync(join(ROOT, 'docs/api/worldmonitor.openapi.yaml')).size;

const TOOL_TOKEN_RE = /`((?:get|generate|analyze|search|describe|list|open|set|switch|focus|move|create|rename|delete|select|apply)_[a-z0-9_]+|openCountryBrief|openSearch)`/g;
const webmcp = readFileSync(join(ROOT, 'src/config/webmcp.ts'), 'utf8');
const spaTools = webmcp.match(/export const WEBMCP_SPA_TOOL = Object\.freeze\(\{([\s\S]*?)\} as const\)/)?.[1];
assert.ok(spaTools, 'the canonical browser tool contract must be extractable');
const browserTools = new Set([...spaTools.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]));

// Generated methodology and snapshots retain upstream provenance, not promises
// that every historical tool or account-backed interface ships in this fork.
function activeBrief(text) {
  return text.split('\n## Generated corpus\n')[0];
}

function citedTools(text) {
  return [...new Set([...text.matchAll(TOOL_TOKEN_RE)].map((m) => m[1]))].sort();
}

describe('agent readiness: public agent interfaces', () => {
  it('browser tool citations derive from the genuine dashboard contract', () => {
    assert.ok(browserTools.size > 0);
    const registration = readFileSync(join(ROOT, 'src/services/webmcp.ts'), 'utf8');
    for (const criticalTool of ['get_dashboard_context', 'list_map_layers', 'get_access_context']) {
      assert.ok(browserTools.has(criticalTool), `missing browser discovery tool ${criticalTool}`);
    }
    assert.match(registration, /modelContext\.registerTool/);
  });

  it('documentation MCP is an upstream transport, not a local product tool registry', () => {
    const transport = readFileSync(join(ROOT, 'api/docs-mcp.ts'), 'utf8');
    assert.match(transport, /const UPSTREAM_URL = 'https:\/\/worldmonitor\.mintlify\.dev\/docs\/mcp'/);
    assert.match(transport, /fetch\(UPSTREAM_URL/);
    assert.doesNotMatch(transport, /registerTool\s*\(/);
  });

  for (const rel of LLMS_FILES) {
    const text = activeBrief(LLMS_TEXTS.get(rel));
    const cited = citedTools(text);

    it(`${rel} distinguishes documentation MCP, browser WebMCP and public REST`, () => {
      assert.match(text, /https:\/\/www\.worldmonitor\.app\/docs\/mcp/);
      assert.match(text, /documentation search and retrieval/i);
      assert.match(text, /Browser WebMCP/);
      assert.match(text, /(?:in-page|in-browser)/);
      assert.match(text, /public request shapes/i);
      assert.match(text, /\/api\/news\/v1\/list-feed-digest\?variant=full&lang=en&public=1/);
      assert.match(text, /no accounts, subscriptions, account keys, or paid plans/);
      if (rel !== 'public/llms-full.txt') {
        assert.ok(cited.length > 0, `${rel} must retain actionable browser tool guidance`);
      }
    });

    it(`${rel} does not promise retired product tools or account access`, () => {
      const unknown = cited.filter((t) => !browserTools.has(t));
      assert.deepEqual(
        unknown,
        [],
        `${rel} cites unsupported browser tools: ${unknown.join(', ')}`,
      );
      assert.doesNotMatch(text, /X-WorldMonitor-Key|scope=mcp|subscription-gated|OAuth 2\.1/);
      assert.doesNotMatch(text, /https:\/\/(?:www\.)?worldmonitor\.app\/(?:mcp(?:[\/\s`)]|$)|pro(?:[\/?#\s`)]|$)|pricing\.md|auth\.md|\.well-known\/oauth-)/);
    });
  }

  it('public/llms.txt wraps every list-item URL in a Markdown link', () => {
    const text = LLMS_TEXTS.get('public/llms.txt');
    const listItemsWithUrls = text.split('\n').filter((line) => line.startsWith('- ') && /https?:\/\//.test(line));

    assert.ok(listItemsWithUrls.length > 0, 'public/llms.txt should contain linked resources');
    for (const line of listItemsWithUrls) {
      assert.match(line, /^- \[[^\]]+\]\(https?:\/\/[^)]+\)/, `list item needs a primary Markdown link: ${line}`);
      const withoutMarkdownLinks = line.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '');
      assert.doesNotMatch(withoutMarkdownLinks, /https?:\/\//, `list item contains a bare URL: ${line}`);
    }
  });

  it('public/llms.txt identifies its release and update date', () => {
    assert.match(
      LLMS_TEXTS.get('public/llms.txt'),
      new RegExp(`^> Version: ${PACKAGE_VERSION.replaceAll('.', '\\.')} · Last updated: \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    );
  });

  it('distinguishes static samples and published country provenance from live entitlements', () => {
    for (const [rel, source] of LLMS_TEXTS) {
      const text = activeBrief(source);
      assert.match(text, /https:\/\/www\.worldmonitor\.app\/sandbox\/index\.json/);
      assert.match(text, /static (?:example|sample)/i, `${rel} must label sandbox provenance`);
      assert.match(text, /https:\/\/www\.worldmonitor\.app\/countries\//);
      assert.match(text, /(?:published|source-attributed) (?:country )?(?:snapshot|corpus)/i);
    }
    const corpus = LLMS_TEXTS.get('public/llms-full.txt');
    assert.match(corpus, /## Generated corpus/);
    assert.match(corpus, /Published country resilience ranking/);
    assert.match(corpus, /AGPL-3\.0/);
    assert.match(corpus, /source attribution/i);
  });

  it('annotates the oversized OpenAPI YAML link with its byte size', () => {
    const formattedBytes = new Intl.NumberFormat('en-US').format(OPENAPI_BYTES);
    const text = LLMS_TEXTS.get('public/llms.txt');
    assert.equal(withOpenApiByteSize(text, OPENAPI_BYTES), text,
      `OpenAPI YAML byte annotation must match ${formattedBytes} bytes`);
    assert.match(
      text,
      new RegExp(`openapi\\.yaml[^\\n]*${formattedBytes} bytes`, 'i'),
      `OpenAPI YAML byte annotation must match ${formattedBytes} bytes`,
    );
  });

  it('updates only the YAML byte annotation and rejects ambiguous publication input', () => {
    const source = LLMS_TEXTS.get('public/llms.txt');
    const updated = withOpenApiByteSize(source, 1_234_567);
    assert.equal(updated, source.replace(`${OPENAPI_BYTES.toLocaleString('en-US')} bytes`, '1,234,567 bytes'));
    assert.equal(withOpenApiByteSize(updated, 1_234_567), updated);
    assert.throws(() => withOpenApiByteSize('no annotation', 10), /exactly one/);
    assert.throws(() => withOpenApiByteSize(`${source}\n${source}`, 10), /exactly one/);
  });

  it('preserves committed publication facts for the unit freshness checks', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
    assert.doesNotMatch(scripts['pretest:data'], /build:openapi|build:ai-search|product:facts/);
  });
});
