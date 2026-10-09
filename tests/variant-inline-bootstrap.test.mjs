import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const csp = vercelConfig.headers
  .find((entry) => entry.headers?.some(
    (header) => header.key === 'X-Frame-Options' && header.value === 'SAMEORIGIN',
  ))
  ?.headers
  ?.find((header) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const variantBootstrapScript = indexHtml.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1];
const mapBootstrapScript = indexHtml.match(/<script data-wm-map-prepaint>([\s\S]*?)<\/script>/)?.[1];
const deploymentPolicies = [['vercel.json', csp]];
for (const file of ['docker/nginx.conf', 'docker/nginx-security-headers.conf']) {
  const config = readFileSync(resolve(__dirname, '..', file), 'utf-8');
  const policy = [...config.matchAll(/add_header Content-Security-Policy "([^"]*)"/g)]
    .map((match) => match[1])
    .find((value) => value.includes("'strict-dynamic'"));
  deploymentPolicies.push([file, policy ?? '']);
}

describe('variant inline bootstrap', () => {
  it('detects every public variant host before the app bundle loads', () => {
    for (const variant of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.ok(
        indexHtml.includes(`h.startsWith('${variant}.'))v='${variant}'`),
        `index.html inline bootstrap must set data-variant for ${variant}.worldmonitor.app`,
      );
    }
  });

  for (const [file, policy] of deploymentPolicies) {
    for (const [name, script] of [['variant/theme', variantBootstrapScript], ['map', mapBootstrapScript]]) {
      it(`allows the ${name} prepaint bootstrap through ${file} CSP`, () => {
        assert.ok(script, `index.html must include the ${name} prepaint script`);
        const scriptSources = policy.split(';')
          .find((directive) => directive.trim().startsWith('script-src '))
          ?.trim().split(/\s+/).slice(1) ?? [];

        const hash = createHash('sha256').update(script).digest('base64');
        assert.ok(
          scriptSources.includes(`'sha256-${hash}'`),
          `${file} script-src must authorize sha256-${hash} for the ${name} prepaint script`,
        );
      });
    }
  }
});
