import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeToRepoRoot } from './_lib/import-graph-walk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('relativeToRepoRoot', () => {
  it('returns a forward-slash-separated path for a file under root', () => {
    const target = resolve(root, 'scripts', '_seed-utils.mjs');
    assert.equal(relativeToRepoRoot(root, target), 'scripts/_seed-utils.mjs');
  });

  it('returns a forward-slash-separated path for a nested file under root', () => {
    const target = resolve(root, 'tests', '_lib', 'import-graph-walk.mjs');
    assert.equal(relativeToRepoRoot(root, target), 'tests/_lib/import-graph-walk.mjs');
  });

  it('normalizes Windows paths deterministically on every host', () => {
    assert.equal(
      relativeToRepoRoot('C:\\repo', 'C:\\repo\\scripts\\file.mjs', win32),
      'scripts/file.mjs',
    );
  });

  it('returns null for a path outside root', () => {
    const outside = resolve(root, '..', 'some-sibling-dir', 'file.mjs');
    assert.equal(relativeToRepoRoot(root, outside), null);
  });

  it('returns null for root itself', () => {
    assert.equal(relativeToRepoRoot(root, root), null);
  });

  it('never returns a path containing a backslash, regardless of host path.sep', () => {
    const target = resolve(root, 'server', '_shared', 'brief-render.js');
    const result = relativeToRepoRoot(root, target);
    assert.ok(result, 'expected a non-null result for a file under root');
    assert.ok(!result.includes('\\'), `result should be forward-slash-only, got ${JSON.stringify(result)}`);
  });
});
