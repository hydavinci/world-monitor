import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

const workflow = (name) => load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const upstreamOnly = "github.repository == 'koala73/worldmonitor'";

for (const [file, job] of [
  ['railway-registry-sync.yml', 'reconcile'],
  ['railway-deploy-trigger.yml', 'admission'],
  ['railway-deploy-trigger-watchdog.yml', 'classify'],
  ['railway-reconcile-manual-recovery.yml', 'proof'],
  ['desktop-release-train.yml', 'prepare'],
  ['build-desktop.yml', 'client-env'],
  ['deploy-worker.yml', 'deploy'],
  ['deploy-worker.yml', 'live-smoke'],
  ['deploy-railway-reconcile-control.yml', 'deploy'],
  ['deploy-railway-reconcile-control.yml', 'live-smoke'],
  ['analytics-collector-monitor.yml', 'monitor'],
  ['crawlable-pulse-refresh.yml', 'refresh'],
  ['feed-validation.yml', 'validate'],
  ['github-stars-refresh.yml', 'refresh'],
  ['indexnow-submit.yml', 'submit-indexnow'],
  ['mcp-live-smoke.yml', 'smoke'],
  ['mcp-preset-liveness.yml', 'monitor'],
  ['postmerge-deploy-monitor.yml', 'monitor'],
  ['publish-cli.yml', 'publish'],
  ['docker-publish.yml', 'docker'],
  ['publish-e2e-screenshots.yml', 'publish'],
  ['publish-go.yml', 'publish'],
  ['publish-mcp-registry.yml', 'publish'],
  ['publish-python.yml', 'publish'],
  ['publish-ruby.yml', 'publish'],
  ['pulse-freshness-monitor.yml', 'monitor'],
  ['railway-deploy-drift.yml', 'monitor'],
  ['resilience-snapshot-refresh.yml', 'refresh'],
  ['seed-freshness-monitor.yml', 'monitor'],
  ['sentry-resolve-pin-audit.yml', 'audit'],
  ['seo-gsc-weekly.yml', 'guard'],
  ['test-linux-app.yml', 'test-linux-app'],
  ['umami-storage-monitor.yml', 'monitor'],
]) {
  test(`${file}: ${job} requires ownership of upstream infrastructure`, () => {
    assert.ok(workflow(file).jobs[job].if?.includes(upstreamOnly), 'production jobs must fail closed outside the upstream repository');
    const expression = workflow(file).jobs[job].if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const github = {
      repository: 'hydavinci/world-monitor',
      ref: 'refs/heads/main',
      event_name: 'schedule',
      event: {
        deployment_status: { state: 'success' },
        deployment: { environment: 'Production', creator: { login: 'vercel[bot]' } },
        workflow_run: { head_branch: 'main', event: 'push', conclusion: 'success' },
      },
    };
    assert.equal(runInNewContext(expression, { github }, { timeout: 1000 }), false, 'an upstream event condition must not bypass repository admission');
  });
}

test('Cloudflare admission does not disable the worker unit tests', () => {
  for (const name of ['deploy-worker.yml', 'deploy-railway-reconcile-control.yml']) {
    const job = workflow(name).jobs['unit-test'];
    assert.ok(job.steps.some((step) => step.run === 'npm test'));
    assert.equal(job.if, undefined);
  }
});

test('forks retain the normal code, browser and security quality gates', () => {
  for (const name of ['test.yml', 'typecheck.yml', 'lint-code.yml', 'security-audit.yml', 'proto-check.yml', 'e2e-visual.yml']) {
    const jobs = workflow(name).jobs;
    assert.ok(Object.keys(jobs).length > 0);
    for (const [id, job] of Object.entries(jobs)) {
      assert.ok(!job.if?.includes(upstreamOnly), `${name}: ${id} must not be disabled in forks`);
      assert.notEqual(job['continue-on-error'], true, `${name}: ${id} must not ignore failures`);
    }
  }
});

test('Redis installation refreshes runner package indexes before installing', () => {
  const install = workflow('test.yml').jobs['unit-shards'].steps.find((step) => step.name === 'Install Redis for the archive Lua suite');
  assert.ok(install);
  assert.match(install.run, /sudo apt-get update/);
  assert.ok(install.run.indexOf('sudo apt-get update') < install.run.indexOf('sudo apt-get install'));
  assert.match(install.run, /redis-server redis-tools/);
});

test('built-output checks cover retained dashboard and embed surfaces, not retired Pro output', () => {
  const step = workflow('test.yml').jobs['unit-built-output'].steps.find((candidate) => candidate.name?.startsWith('Client bundle size budget'));
  assert.ok(step, 'the built-output job must enforce client bundle budgets');
  const run = step.run;
  assert.match(run, /npm run bundle:check(?:\s|$)/);
  assert.match(run, /npm run bundle:check:embed/);
  assert.doesNotMatch(run, /bundle:check:pro/);
});
