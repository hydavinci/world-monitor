import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const workflowPath = resolve(repoRoot, '.github/workflows/test.yml');
const guardModuleUrl = pathToFileURL(resolve(repoRoot, 'tests/_lib/built-output-guard.mjs')).href;

const guardProbeSource = [
  "import { describe, it } from 'node:test';",
  "import { writeFileSync } from 'node:fs';",
  `import { guardBuiltOutput, shouldSkipBuiltOutput } from ${JSON.stringify(guardModuleUrl)};`,
  "const dashboardHtml = process.env.WM_DASHBOARD_GUARD_DASHBOARD;",
  "const expectBuiltOutput = process.env.WM_EXPECT_BUILT_OUTPUT === '1';",
  "writeFileSync(process.env.WM_DASHBOARD_GUARD_LOADED, 'loaded');",
  "describe('built-output guard probe', { skip: shouldSkipBuiltOutput(dashboardHtml, expectBuiltOutput) }, () => {",
  "  writeFileSync(process.env.WM_DASHBOARD_GUARD_SUITE, 'entered');",
  "  guardBuiltOutput(dashboardHtml, expectBuiltOutput);",
  "  it('executes the built-output assertion', () => {",
  "    writeFileSync(process.env.WM_DASHBOARD_GUARD_ASSERTION, 'ran');",
  "  });",
  "});",
].join('\n');

function runGuardProbe(expectBuiltOutput) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'worldmonitor-built-output-guard-'));
  const probePath = join(fixtureRoot, 'guard-probe.test.mjs');
  const dashboardHtml = join(fixtureRoot, 'dist', 'dashboard.html');
  const loadedMarker = join(fixtureRoot, 'loaded');
  const suiteMarker = join(fixtureRoot, 'suite');
  const assertionMarker = join(fixtureRoot, 'assertion');

  try {
    writeFileSync(probePath, guardProbeSource);
    const env = {
      ...process.env,
      WM_DASHBOARD_GUARD_DASHBOARD: dashboardHtml,
      WM_DASHBOARD_GUARD_LOADED: loadedMarker,
      WM_DASHBOARD_GUARD_SUITE: suiteMarker,
      WM_DASHBOARD_GUARD_ASSERTION: assertionMarker,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    if (expectBuiltOutput) env.WM_EXPECT_BUILT_OUTPUT = '1';
    else delete env.WM_EXPECT_BUILT_OUTPUT;

    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', probePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    });

    return {
      ...result,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      loaded: existsSync(loadedMarker),
      suite: existsSync(suiteMarker),
      assertion: existsSync(assertionMarker),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('built-output guard contract', () => {
  it('runs public prehydration checks without a retired Pro build prerequisite', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const fullE2eScript = packageJson.scripts?.['test:e2e:full'] ?? '';
    const prehydrationScript = packageJson.scripts?.['test:e2e:prehydration'] ?? '';
    const prehydrationSource = readFileSync(
      resolve(repoRoot, 'e2e/prehydration-shell.spec.ts'),
      'utf8',
    );
    const workflow = readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
    assert.match(
      fullE2eScript,
      /VITE_VARIANT=full playwright test/,
      'full browser checks must retain the public dashboard variant',
    );
    assert.match(
      prehydrationScript,
      /playwright test e2e\/prehydration-shell\.spec\.ts --project=chromium --grep "dashboard shell without JavaScript"/,
      'the focused CI script must execute the retained no-JavaScript dashboard check in Chromium',
    );
    assert.doesNotMatch(
      prehydrationSource,
      /test\.skip\(/,
      'the public prehydration checks must not silently skip',
    );
    assert.ok(
      workflow.includes('        run: npm run test:e2e:prehydration'),
      'CI must execute the public prehydration script',
    );
    assert.doesNotMatch(`${fullE2eScript}\n${prehydrationScript}\n${workflow}`, /\bbuild:pro\b/);
  });

  it('keeps the dashboard build immediately before the marker-enabled data test in CI', () => {
    const workflow = readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
    // The bundle-size gate (#7111) sits between the build and test:data on
    // purpose: it reads the freshly built dist/ without mutating it, and a
    // budget breach should cost seconds, not the full test:data run. Pinning
    // it in this sequence keeps both contracts — the data test still runs
    // against the dist the step above just built, and the gate cannot drift
    // to a position where dist/ might be stale or absent.
    const expectedSequence = [
      '      - name: Build dashboard artifacts for built-output tests',
      '        run: VITE_VARIANT=full ./node_modules/.bin/vite build',
      '      - name: Client bundle size budget (#7111, #7119)',
    ].join('\n');
    const expectedTailSequence = [
      '        run: |',
      '          npm run bundle:check',
      '          npm run bundle:check:embed',
      '      - run: WM_EXPECT_BUILT_OUTPUT=1 npm run test:data -- --built-output=only --concurrency=4 --timings=${{ runner.temp }}/data-test-timings.jsonl',
    ].join('\n');

    assert.ok(
      workflow.includes(expectedSequence),
      'the public built-output job must build dashboard artifacts before checking their size',
    );
    assert.ok(
      workflow.includes(expectedTailSequence),
      'the bundle-size gate must run immediately before test:data with WM_EXPECT_BUILT_OUTPUT=1, with nothing between it and the build except the gate itself',
    );
    assert.equal(
      workflow.match(/WM_EXPECT_BUILT_OUTPUT=1 npm run test:data/g)?.length ?? 0,
      1,
      'the CI marker command should remain a single, explicit unit-job contract',
    );
  });

  it('wires public built-output suites to the shared fail-closed primitive', () => {
    for (const file of ['dashboard-eager-chunks.test.mjs', 'dashboard-critical-css.test.mjs']) {
      const source = readFileSync(resolve(repoRoot, 'tests', file), 'utf8');
      assert.match(source, /from '\.\/_lib\/built-output-guard\.mjs'/);
      assert.match(source, /shouldSkipBuiltOutput\(dashboardHtml\)/);
      assert.match(source, /guardBuiltOutput\(dashboardHtml\)/);
    }
    assert.equal(existsSync(resolve(repoRoot, '.github/workflows/pro-bundle-freshness.yml')), false);
    assert.equal(existsSync(resolve(repoRoot, 'pro-test')), false);
  });

  it('skips the built-output suite when the marker is absent and output is missing', () => {
    const result = runGuardProbe(false);

    assert.equal(result.status, 0, result.output);
    assert.equal(result.loaded, true, 'the probe module should load');
    assert.equal(result.suite, false, 'node:test should skip the built-output suite');
    assert.equal(result.assertion, false, 'the built-output assertion must not run');
  });

  it('fails the built-output suite when CI expects output but it is missing', () => {
    const result = runGuardProbe(true);

    // CI uses Node 24: a guard failure must fail the process as well as the
    // suite. The probe selects TAP explicitly because Node 24 defaults to spec.
    assert.notEqual(result.status, 0, result.output);
    assert.match(
      result.output,
      /^not ok 1 - built-output guard probe$/m,
      `the probe suite must be reported as failed:\n${result.output}`,
    );
    assert.match(
      result.output,
      /missing but WM_EXPECT_BUILT_OUTPUT=1 indicates CI expected a build/,
      `the failure must come from the guard, not an unrelated crash:\n${result.output}`,
    );
    assert.notEqual(result.status, null, 'the probe process must not have been killed by a signal');
    assert.equal(result.loaded, true, 'the probe module should load');
    assert.equal(result.suite, true, 'the suite callback should run when CI expects built output');
    assert.equal(result.assertion, false, 'the assertion must not run after the guard fails');
  });
});
