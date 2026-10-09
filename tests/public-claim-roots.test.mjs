import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import {
  ACQUISITION_CLAIM_ROOTS,
  collectCurrentAcquisitionClaimFiles,
} from '../scripts/docs-stats.mjs';

const REQUIRED_ROOTS = [
  'README.ja-JP.md',
  'README.md',
  'README.zh-CN.md',
  'blog-site/src/content/blog',
  'cli',
  'docs',
  'index.html',
  'public',
  'public/.well-known/agent-skills',
  'public/.well-known/ai-catalog.json',
  'public/api/llms.txt',
  'scripts/build-agent-skills-index.mjs',
  'server.json',
];
const PUBLIC_FILES = [
  'README.ja-JP.md',
  'README.md',
  'README.zh-CN.md',
  'blog-site/src/content/blog/public-news.md',
  'cli/README.md',
  'docs/panels/news-feeds.mdx',
  'index.html',
  'public/.well-known/agent-skills/public-news/SKILL.md',
  'public/.well-known/ai-catalog.json',
  'public/api/llms.txt',
  'public/llms.txt',
  'scripts/build-agent-skills-index.mjs',
  'server.json',
];

function withClaimFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'wm-public-claim-roots-'));
  try {
    for (const path of [
      ...PUBLIC_FILES,
      'docs/archive/old.md',
      'public/pro/index.html',
      'pro-test/index.html',
      'pro-test/welcome.html',
      'pro-test/src/locales/en.json',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), '500+ curated news feeds\n');
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('registers every retained public claim root without requiring retired Pro roots', () => {
  assert.deepEqual([...ACQUISITION_CLAIM_ROOTS].sort(), REQUIRED_ROOTS);
});

it('admits the complete retained public closure recursively but not retired Pro copy', () => {
  withClaimFixture((root) => {
    assert.deepEqual(collectCurrentAcquisitionClaimFiles(root), PUBLIC_FILES);
  });
});

it('fails closed for each missing required public claim root', () => {
  for (const path of REQUIRED_ROOTS) {
    withClaimFixture((root) => {
      rmSync(join(root, path), { recursive: true });
      assert.throws(
        () => collectCurrentAcquisitionClaimFiles(root),
        { message: `docs-stats: required acquisition claim root is missing: ${path}` },
      );
    });
  }
});
