import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const template = readFileSync(new URL('docker/nginx.conf.template', root), 'utf8');
const dockerfile = readFileSync(new URL('docker/Dockerfile', root), 'utf8');

test('the static image cannot delegate requests to an upstream API', () => {
  for (const file of [
    'docker/nginx.conf.template',
    'docker/nginx-security-headers.conf',
    'docker/nginx-embed-security-headers.conf',
  ]) {
    const config = readFileSync(new URL(file, root), 'utf8').replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(config, /\b(?:proxy_pass|fastcgi_pass|uwsgi_pass|grpc_pass|scgi_pass|upstream)\b/, file);
    assert.doesNotMatch(config, /\$\{?API_UPSTREAM\b/, file);
  }
});

test('both static API namespace entrypoints return explicit non-cacheable unavailability', () => {
  for (const route of ['= /api', '^~ /api/']) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = template.match(new RegExp(`location\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`))?.[1];
    assert.ok(body, `API route ${route} must not fall through to static files or the SPA`);
    assert.match(body, /\bdefault_type\s+application\/json\s*;/);
    const response = body.match(/\breturn\s+(\d+)\s+'([^']+)'\s*;/);
    assert.ok(response, `${route} must return a JSON error`);
    assert.equal(Number(response[1]), 503);
    const payload = JSON.parse(response[2]);
    assert.equal(payload.error, 'api_unavailable');
    assert.ok(typeof payload.message === 'string' && payload.message.length > 0);
    const cache = body.match(/add_header\s+Cache-Control\s+"([^"]+)"\s+always\s*;/)?.[1];
    assert.match(cache ?? '', /private/);
    assert.match(cache ?? '', /no-store/);
  }
});

test('the static build has no implicit official API or websocket upstream', () => {
  assert.doesNotMatch(dockerfile, /^\s*(?:ARG|ENV)\s+(?:API_UPSTREAM|VITE_WS_API_URL)\b/m);
  assert.match(dockerfile, /COPY\s+docker\/nginx\.conf\.template\s+\/etc\/nginx\/nginx\.conf\s*$/m);
});

test('retired commercial pages and assets cannot fall back to static Pro content', () => {
  const locations = [...template.matchAll(/location\s+~\s+(\S+)\s*\{([\s\S]*?)\n\s*\}/g)];
  for (const path of [
    '/pro', '/pro/assets/legacy.js', '/pricing.md', '/oauth/authorize',
    '/mcp/server', '/mcp-grant.html', '/widget-agent', '/ask', '/a2a', '/agent/auth',
  ]) {
    const route = locations.find(([, pattern]) => new RegExp(pattern).test(path));
    assert.ok(route, `retired ${path} must not select static files or the SPA`);
    const response = route[2].match(/\breturn\s+(\d+)\s+'([^']+)'\s*;/);
    assert.ok(response);
    assert.equal(Number(response[1]), 403);
    assert.equal(JSON.parse(response[2]).error, 'feature_removed');
    assert.doesNotMatch(route[2], /\btry_files\b/);
  }
  for (const path of ['/embed', '/docs/mcp', '/mcp-server.md', '/professional']) {
    assert.equal(locations.some(([, pattern]) => new RegExp(pattern).test(path)), false, path);
  }
});

test('inherited API_UPSTREAM cannot make the static entrypoint render a proxy configuration', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'wm-static-entrypoint-'));
  try {
    writeFileSync(join(fixture, 'nginx'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const result = spawnSync('/bin/sh', [fileURLToPath(new URL('docker/docker-entrypoint.sh', root))], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, API_UPSTREAM: 'https://retired-upstream-fixture.invalid' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '-g\ndaemon off;\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the full image retains its local API proxy and sidecar transport authentication', () => {
  const config = readFileSync(new URL('docker/nginx.conf', root), 'utf8');
  const api = config.match(/location\s+\/api\/\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  assert.ok(api);
  assert.match(api, /proxy_pass\s+http:\/\/127\.0\.0\.1:\$\{LOCAL_API_PORT\}\s*;/);
  assert.match(api, /proxy_set_header\s+X-WorldMonitor-Local-Token\s+"\$\{LOCAL_API_TOKEN\}"\s*;/);
});
