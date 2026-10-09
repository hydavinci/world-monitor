#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

// timeoutMs note: section timeouts are sized against measured runtime and each seeder's own
// internal deadline, NOT against Railway's container cap. #6556: every section
// here was declared at 600-900s, which is above the 570s bundle budget once the
// runner's 10s kill grace is added, so the admission check deferred all three
// on every tick and exited 0 — the service published nothing for six hours
// under a green badge. A timeout above the container cap never bounded anything
// anyway: Railway SIGKILLs at 10 minutes, taking the logs with it.
await runBundle('resilience', [
  // 11 dataset adapters run concurrently (Promise.allSettled), each fetch
  // withRetry(2, 750) over a 30s timeout, so the design worst case is ~92s for
  // the slowest chain plus a Redis pipeline publish. 280s is ~3x that.
  //
  // measured 2026-08-17: 2.7s full-run (196 records; 0 failed datasets), from
  // Railway deployment 0b181beb-20aa-498c-94be-088a344fe493 at commit 8b2bc625.
  // The source log fields and runner confirmation are frozen in
  // scripts/resilience-static-full-run-evidence.json. `--measure-fetch-only`
  // remains a diagnostic and is not timeout or placement evidence.
  //
  // Runtime admission uses timeout + 10s kill grace. Scores' 250s worst case,
  // Static's 290s worst case, and the runner's 15s admission headroom total
  // 555s, leaving 15s in the 570s budget. This keeps Static admissible even if
  // Scores consumes its full reservation; the timeout is not sized from 2.7s
  // alone.
  { label: 'Resilience-Static', script: 'seed-resilience-static.mjs', seedMetaKey: 'resilience:static', intervalMs: 90 * DAY, timeoutMs: 280_000 },
], {
  // Railway kills the container at 10 minutes. The runner admits a section only
  // when `timeoutMs + KILL_GRACE_MS` still fits the remaining budget, so without
  // this a 600s section plus grace could start with no room to finish and be
  // SIGKILLed mid-publish instead of skipped cleanly. Every section above must
  // fit this budget outright — runBundle now refuses to start otherwise, and
  // tests/bundle-budget-admission.test.mjs pins the arithmetic in CI.
  maxBundleMs: 570_000,
});
