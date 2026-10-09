import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { it } from 'node:test';

const baseUrl = new URL('../blog-site/src/layouts/Base.astro', import.meta.url);
const base = readFileSync(baseUrl, 'utf8');
const post = readFileSync(new URL('../blog-site/src/layouts/BlogPost.astro', import.meta.url), 'utf8');
const link = readFileSync(new URL('../blog-site/src/components/TrackedProductLink.astro', import.meta.url), 'utf8');

it('keeps every literal blog-shell JSON dependency available to a clean build', () => {
  for (const [, specifier] of base.matchAll(/from\s+['"]([^'"]+\.json)['"]/g)) {
    assert.ok(existsSync(new URL(specifier, baseUrl)), `Missing blog dependency: ${specifier}`);
  }
});

it('keeps the public blog shell free of subscription promotion and analytics', () => {
  assert.doesNotMatch(base + post, /product-facts\.generated|destination="pro"|Explore Pro|Pro workflows/);
  assert.doesNotMatch(base, /abacus\.worldmonitor\.app|data-website-id|utmParams|wm_content_/);
  assert.match(base, /destination="dashboard"/);
  assert.match(post, /<slot\s*\/>/);
  assert.match(post, /"@type": "BlogPosting"/);
});

it('renders public blog handoffs without telemetry or acquisition parameters', () => {
  assert.doesNotMatch(link, /data-umami|BLOG_CONVERSION|buildBlogProductLinkUrl|normalizeBlogAttributionToken/);
  assert.match(link, /dashboard:\s*['"]\/['"]/);
  assert.match(link, /api:\s*['"]\/openapi\.yaml['"]/);
  assert.match(link, /mcp:\s*['"]\/docs\/mcp['"]/);
  assert.match(link, /href=\{linkHref\}/);
  assert.match(link, /rel="noopener noreferrer"/);
});
