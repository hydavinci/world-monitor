import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { classifyRustAudit, runRustAudit } from '../.github/scripts/audit-rust-dependencies.mjs';
import {
  GLIB_BACKPORT, glibSourceContract, verifyGlibBackport,
} from '../.github/scripts/verify-glib-backport.mjs';
const auditInputDir = mkdtempSync(join(tmpdir(), 'rust-audit-input-'));
mkdirSync(join(auditInputDir, 'src-tauri'));
const fixtureLock = join(auditInputDir, 'src-tauri/Cargo.lock');
writeFileSync(fixtureLock, '# synthetic non-glib audit input');
after(() => rmSync(auditInputDir, { recursive: true, force: true }));
const now = Date.parse('2026-09-08');
test('workflow caches only the pinned audit binary and installs on a miss', () => {
  const workflow = YAML.parse(readFileSync('.github/workflows/security-audit.yml', 'utf8'));
  const steps = workflow.jobs['audit-rust'].steps;
  const cache = steps.find((step) => step.id === 'cargo-audit-cache');
  const install = steps.find((step) => step.name === 'Install pinned advisory tool');
  const audit = steps.find((step) => step.name === 'Audit Cargo.lock');
  assert.ok(cache, 'restore the binary before installing');
  assert.match(cache.uses, /^actions\/cache@[a-f0-9]{40}$/);
  assert.equal(cache.with.path, '~/.cargo/bin/cargo-audit');
  assert.equal(cache.with.key, 'cargo-audit-0.22.2-${{ runner.os }}-${{ runner.arch }}');
  assert.equal(cache.with['restore-keys'], undefined);
  assert.equal(install.if, "steps.cargo-audit-cache.outputs.cache-hit != 'true'");
  assert.equal(install.run, 'cargo install cargo-audit --version 0.22.2 --locked');
  assert.ok(steps.indexOf(cache) < steps.indexOf(install));
  assert.ok(steps.indexOf(install) < steps.indexOf(audit));
  assert.equal(audit.if, undefined, 'audit must run on cache hits and misses');
  assert.equal(audit.run, 'node .github/scripts/audit-rust-dependencies.mjs');
});
const finding = (patched = ['>=1.1.0']) => ({
  advisory: { id: 'RUSTSEC-2026-0001' },
  package: { name: 'fixture', version: '1.0.0' },
  versions: { patched },
});
const report = (list = []) => ({
  database: { 'advisory-count': 1, 'last-commit': null },
  lockfile: { 'dependency-count': 1 },
  settings: { ignore: [], target_arch: [], target_os: [], severity: null },
  vulnerabilities: { found: list.length > 0, count: list.length, list },
  warnings: {},
});
const decision = {
  status: 'approved',
  approvedBy: 'synthetic fixture reviewer',
  approvedAt: '2026-09-01',
  id: 'RUSTSEC-2026-0001',
  owner: '#5935',
  reason: 'Fixture API does not receive untrusted data',
  expiresAt: '2026-10-01',
};
test('clean, fixable and no-fix results stay distinct', () => {
  assert.equal(classifyRustAudit(report(), [], now).status, 'clean');
  assert.equal(classifyRustAudit(report([finding()]), [], now).status, 'failed');
  const noFix = classifyRustAudit(report([finding([])]), [], now);
  assert.equal(noFix.status, 'warning');
  assert.equal(noFix.noFix.length, 1);
});
test('decisions require owner, reason, expiry and unique IDs', () => {
  for (const patch of [{ owner: '' }, { reason: '' }, { expiresAt: null }, { id: 'bad' }])
    assert.throws(() => classifyRustAudit(report(), [{ ...decision, ...patch }], now));
  assert.throws(() => classifyRustAudit(report(), [decision, decision], now));
});
test('a decision expires at its boundary and cannot silently become stale', () => {
  assert.equal(classifyRustAudit(report([finding()]), [decision], now).approved.length, 1);
  const expired = classifyRustAudit(report([finding([])]), [decision], Date.parse(decision.expiresAt));
  assert.equal(expired.status, 'failed');
  assert.match(expired.decisionErrors[0], /expired/);
  assert.equal(classifyRustAudit(report(), [decision], now).status, 'failed');
});
test('malformed and ignored reports cannot become clean', () => {
  for (const input of [
    {},
    { ...report(), lockfile: { 'dependency-count': 0 } },
    { ...report(), settings: { ignore: ['RUSTSEC-2026-0001'] } },
    { ...report(), vulnerabilities: { count: 0, list: [finding()] } },
    report([{ ...finding(), versions: {} }]),
  ])
    assert.throws(() => classifyRustAudit(input, [], now));
});
test('informational notices remain visible', () => {
  const input = report();
  input.warnings.unmaintained = [finding([])];
  const result = classifyRustAudit(input, [], now);
  assert.equal(result.status, 'warning');
  assert.equal(result.warnings[0].kind, 'unmaintained');
});
test('database outage never invokes the audit and strict sweep fails', () => {
  for (const strict of [false, true]) {
    let calls = 0;
    const result = runRustAudit({
      lockfile: fixtureLock,
      decisions: [],
      failOnOutage: strict,
      run: (command) => {
        calls++;
        assert.equal(command, 'git');
        return { status: 128, stderr: 'Could not resolve host' };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.failed, strict);
  }
});
test('runner uses fresh DB, neutral cwd and exact lockfile then classifies real report', () => {
  let calls = 0;
  const result = runRustAudit({
    lockfile: fixtureLock,
    decisions: [],
    run: (command, args, options) => {
      calls++;
      if (command === 'git') return { status: 0 };
      assert.equal(command, 'cargo');
      assert.ok(args.includes('--no-fetch'));
      assert.ok(args.includes('--no-yanked'));
      assert.ok(args.at(-1).endsWith('/src-tauri/Cargo.lock'));
      assert.notEqual(options.cwd, process.cwd());
      return { status: 1, stdout: JSON.stringify(report([finding()])) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.failed, true);
});
test('missing input, missing tool and invalid audit output hard-fail', () => {
  assert.throws(() => runRustAudit({ lockfile: '/nonexistent/Cargo.lock', decisions: [] }));
  assert.throws(() =>
    runRustAudit({
      lockfile: fixtureLock,
      decisions: [],
      run: () => ({ error: Object.assign(new Error('missing git'), { code: 'ENOENT' }) }),
    }),
  );
  assert.throws(() =>
    runRustAudit({
      lockfile: fixtureLock,
      decisions: [],
      run: (cmd) => (cmd === 'git' ? { status: 0 } : { status: 1, stdout: '{}' }),
    }),
  );
});

test('the actual aggregate shell preserves Rust verdicts and outage policy', () => {
  const workflow = YAML.parse(readFileSync('.github/workflows/security-audit.yml', 'utf8'));
  const job = workflow.jobs['security-audit'];
  assert.ok(job.needs.includes('audit-rust'));
  const step = job.steps.find((s) => s.run);
  const dir = mkdtempSync(join(tmpdir(), 'rust-aggregate-'));
  try {
    mkdirSync(join(dir, 'audit-status'));
    for (const name of step.env.AUDIT_NAMES.split(' '))
      writeFileSync(join(dir, 'audit-status', `${name}.txt`), 'passed\n');
    for (const [status, strict, expected] of [
      ['clean', false, 0],
      ['warning', true, 0],
      ['failed', false, 1],
      ['unavailable', false, 0],
      ['unavailable', true, 1],
      ['missing', false, 1],
      ['missing', true, 1],
      ['unexpected', false, 1],
    ]) {
      const file = join(dir, 'audit-status/rust.txt');
      if (status === 'missing') rmSync(file, { force: true });
      else writeFileSync(file, `${status}\n`);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          AUDIT_NAMES: step.env.AUDIT_NAMES,
          AUDIT_RESULT: 'success',
          RUST_RESULT: 'success',
          FAIL_ON_OUTAGE: strict ? '1' : '0',
        },
      });
      assert.equal(result.status, expected, `${status} strict=${strict}: ${result.stdout} ${result.stderr}`);
      if (status === 'unavailable') assert.match(result.stdout, /NOT audited/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('fixable unsoundness warnings block; no-fix unsoundness stays explicit', () => {
  const input = report();
  input.warnings.unsound = [finding()];
  assert.equal(classifyRustAudit(input, [], now).status, 'failed');
  input.warnings.unsound = [finding([])];
  assert.equal(classifyRustAudit(input, [], now).noFix.length, 1);
  assert.equal(classifyRustAudit(input, [decision], now).approved.length, 1);
});

test('CLI writes a failed verdict for findings and bad decisions through real subprocesses', () => {
  const script = resolve('.github/scripts/audit-rust-dependencies.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rust-cli-'));
  try {
    mkdirSync(join(dir, 'src-tauri'));
    mkdirSync(join(dir, '.github'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'src-tauri/Cargo.lock'), '# synthetic lock input');
    writeFileSync(join(dir, '.github/rust-advisory-decisions.json'), '[]');
    writeFileSync(join(dir, 'bin/git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'bin/cargo'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(report([finding()]))}'\nexit 1\n`, {
      mode: 0o755,
    });
    const status = join(dir, 'status.txt');
    const invoke = () =>
      spawnSync(process.execPath, [script], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, AUDIT_STATUS_FILE: status },
      });
    const findingResult = invoke();
    assert.equal(findingResult.status, 1, findingResult.stderr);
    assert.equal(readFileSync(status, 'utf8'), 'failed\n');
    assert.match(findingResult.stdout, /RUSTSEC-2026-0001/);
    writeFileSync(join(dir, '.github/rust-advisory-decisions.json'), '{}');
    const invalid = invoke();
    assert.equal(invalid.status, 1);
    assert.equal(readFileSync(status, 'utf8'), 'failed\n');
    assert.match(invalid.stdout, /decisions must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired decisions fail before a database outage can soften the result', () => {
  assert.throws(
    () =>
      runRustAudit({
        lockfile: fixtureLock,
        decisions: [decision],
        now: Date.parse(decision.expiresAt),
        run: () => assert.fail('must reject the expired decision before fetching'),
      }),
    /decisions expired/,
  );
});

test('a proposed exception cannot suppress a fixable advisory', () => {
  const proposed = { ...decision, status: 'proposed' };
  const result = classifyRustAudit(report([finding()]), [proposed], now);
  assert.equal(result.status, 'failed');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.approved.length, 0);
  assert.equal(result.proposed.length, 1);
  assert.throws(() => classifyRustAudit(report([finding()]), [{ ...decision, approvedBy: '' }], now));
  assert.throws(() => classifyRustAudit(report([finding()]), [{ ...decision, approvedAt: null }], now));
});

test('the real glib backport cannot be audited without fresh compiled control/patched proof', () => {
  const result = spawnSync(process.execPath, ['.github/scripts/audit-rust-dependencies.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, GLIB_BACKPORT_PROOF: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /glib backport.*proof/i);
});

test('CI compiles and executes the optimized control and patched regression before auditing', () => {
  const workflow = YAML.parse(readFileSync('.github/workflows/security-audit.yml', 'utf8'));
  const steps = workflow.jobs['audit-rust'].steps;
  const native = steps.find((step) => step.name === 'Install GLib regression prerequisites');
  const regression = steps.find((step) => step.name === 'Prove optimized GLib backport');
  const audit = steps.find((step) => step.name === 'Audit Cargo.lock');
  assert.ok(native, 'the runner must provide GLib headers and pkg-config');
  assert.ok(regression, 'source matching cannot replace a compiled regression');
  assert.ok(steps.indexOf(native) < steps.indexOf(regression));
  assert.ok(steps.indexOf(regression) < steps.indexOf(audit));
  assert.equal(regression.if, undefined);
  assert.equal(regression['continue-on-error'], undefined);
  assert.equal(audit.env.GLIB_BACKPORT_PROOF, regression.env.GLIB_BACKPORT_PROOF);
  assert.equal(regression.run, 'node .github/scripts/verify-glib-backport.mjs');
});

// Cargo/rustc/process boundaries are doubled here because this machine has no
// Rust toolchain. These tests exercise policy, NOT compiled Rust remediation.
function backportFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rust-glib-policy-'));
  for (const path of [GLIB_BACKPORT.path, 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src-tauri/.cargo/config.toml', '.github/workflows/security-audit.yml',
    '.github/scripts/audit-rust-dependencies.mjs']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    cpSync(resolve(path), join(root, path), { recursive: true });
  }
  const work = mkdtempSync(join(root, 'ci-glib-regression-'));
  for (const role of ['control', 'patched']) {
    cpSync(join(root, GLIB_BACKPORT.path), join(work, role), { recursive: true });
    writeFileSync(join(work, role, 'regression/Cargo.lock'), '# synthetic locked fixture');
  }
  for (const path of ['BACKPORT.json', 'BACKPORT.md']) rmSync(join(work, 'control', path));
  const controlIterator = join(work, 'control/src/variant_iter.rs');
  writeFileSync(controlIterator, readFileSync(controlIterator, 'utf8')
    .replace('let mut p: *mut libc::c_char', 'let p: *mut libc::c_char').replace('                &mut p,', '                &p,'));
  const proofFile = join(root, 'proof.json');
  const createdAt = Date.parse('2026-10-09T07:23:10Z');
  const env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const compiler = 'rustc synthetic-policy-fixture\nhost: x86_64-unknown-linux-gnu\n';
  const runtime = {
    control: { status: null, signal: 'SIGSEGV', stdout: 'glib-backport-regression-start\n' },
    patched: { status: 0, signal: null, stdout: 'glib-backport-regression-start\nglib-backport-regression-ok\n' },
  };
  const binaries = {};
  for (const role of ['control', 'patched']) {
    const binary = join(work, `${role}-target/release/glib-backport-regression`);
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, `synthetic ${role} executable boundary`);
    binaries[role] = createHash('sha256').update(readFileSync(binary)).digest('hex');
  }
  const proof = {
    schema: 1, advisory: 'RUSTSEC-2024-0429', version: '0.18.5',
    contract: glibSourceContract(root), createdAt, work, compiler, packageId: 'fixture-glib',
    ci: { sha: env.GITHUB_SHA, runId: '123', attempt: '1' },
    optimization: 3, controlBuild: 0, patchedBuild: 0, binaries, runtime,
    fixtureLockSha256: createHash('sha256').update('# synthetic locked fixture').digest('hex'),
  };
  const metadata = {
    packages: [{ id: 'fixture-glib', name: 'glib', version: '0.18.5', source: null,
      manifest_path: join(root, GLIB_BACKPORT.path, 'Cargo.toml') }],
    resolve: { nodes: [{ id: 'fixture-glib' }] },
  };
  const save = () => writeFileSync(proofFile, JSON.stringify(proof));
  save();
  const run = (executable, args) => {
    if (executable === 'rustc') return { status: 0, stdout: compiler };
    if (executable === 'cargo') {
      assert.equal(args[0], 'metadata');
      assert.ok(args.includes('--locked'));
      assert.equal(args.at(-1), join(root, 'src-tauri/Cargo.toml'));
      return { status: 0, stdout: JSON.stringify(metadata) };
    }
    for (const role of ['control', 'patched'])
      if (executable === join(work, `${role}-target/release/glib-backport-regression`)) return runtime[role];
    assert.fail(`Unexpected external boundary: ${executable}`);
  };
  return {
    root, work, proofFile, proof, metadata, runtime, env, run, save,
    verify: (options = {}) => verifyGlibBackport({ root, proofFile, now: createdAt, env, run, ...options }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const glibReport = () => {
  const input = report();
  input.warnings.unsound = [{
    advisory: { id: 'RUSTSEC-2024-0429' },
    package: { name: 'glib', version: '0.18.5', source: null },
    versions: { patched: ['>=0.20.0'] },
  }];
  return input;
};

test('whole-tree validation rejects changed, missing, moved, additional and symlinked vendor files', () => {
  for (const mutate of [
    (f) => writeFileSync(join(f.root, GLIB_BACKPORT.path, 'LICENSE'), 'license changed'),
    (f) => rmSync(join(f.root, GLIB_BACKPORT.path, 'src/variant_iter.rs')),
    (f) => renameSync(join(f.root, GLIB_BACKPORT.path), join(f.root, 'src-tauri/vendor/moved')),
    (f) => writeFileSync(join(f.root, GLIB_BACKPORT.path, 'extra.rs'), ''),
    (f) => symlinkSync('LICENSE', join(f.root, GLIB_BACKPORT.path, 'extra-link')),
  ]) {
    const f = backportFixture();
    try {
      mutate(f);
      assert.throws(() => f.verify());
    } finally { f.cleanup(); }
  }
});

test('source/config/lock consistency rejects registry, extra or absent glib and moved patch paths', () => {
  for (const mutate of [
    (f) => {
      const path = join(f.root, 'src-tauri/Cargo.lock');
      writeFileSync(path, readFileSync(path, 'utf8').replace('name = "glib"\nversion = "0.18.5"',
        'name = "glib"\nversion = "0.18.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"'));
    },
    (f) => {
      const path = join(f.root, 'src-tauri/Cargo.lock');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n[[package]]\nname = "glib"\nversion = "0.20.0"\n`);
    },
    (f) => {
      const path = join(f.root, 'src-tauri/Cargo.lock');
      writeFileSync(path, readFileSync(path, 'utf8').replace('name = "glib"', 'name = "removed-glib"'));
    },
    (f) => {
      const path = join(f.root, 'src-tauri/Cargo.toml');
      writeFileSync(path, readFileSync(path, 'utf8').replace('vendor/glib-0.18.5', 'vendor/moved'));
    },
    (f) => writeFileSync(join(f.root, 'src-tauri/.cargo/config.toml'), '# changed'),
    (f) => {
      mkdirSync(join(f.root, '.cargo'));
      writeFileSync(join(f.root, '.cargo/config.toml'), '# additional active config');
    },
  ]) {
    const f = backportFixture();
    try {
      mutate(f);
      assert.throws(() => f.verify());
    } finally { f.cleanup(); }
  }
});

test('proof must be fresh, same-run, optimized and bound to current source and build inputs', () => {
  const f = backportFixture();
  try {
    assert.equal(f.verify().sourceTreeSha256, GLIB_BACKPORT.sourceTreeSha256);
    assert.throws(() => f.verify({ proofFile: '' }), /missing.*proof/);
    assert.throws(() => f.verify({ now: f.proof.createdAt + 3600000 }), /stale/);
    assert.throws(() => f.verify({ now: f.proof.createdAt - 1 }), /stale/);
    assert.throws(() => f.verify({ env: { ...f.env, GITHUB_RUN_ATTEMPT: '2' } }), /different/);
    assert.throws(() => f.verify({ env: { ...f.env, GITHUB_SHA: 'b'.repeat(40) } }), /different/);
    for (const key of Object.keys(f.proof.contract)) {
      const original = f.proof.contract[key];
      f.proof.contract[key] = 'stale';
      f.save();
      assert.throws(() => f.verify(), /no longer matches/);
      f.proof.contract[key] = original;
    }
    f.proof.optimization = 0;
    f.save();
    assert.throws(() => f.verify(), /optimized/);
    f.proof.optimization = 3;
    f.proof.controlBuild = 101;
    f.save();
    assert.throws(() => f.verify(), /builds/);
  } finally { f.cleanup(); }
});

test('Cargo metadata must resolve exactly the path crate, not a registry or second glib', () => {
  for (const mutate of [
    (metadata) => { metadata.packages[0].source = 'registry+https://github.com/rust-lang/crates.io-index'; },
    (metadata) => { metadata.packages.push({ ...metadata.packages[0] }); },
    (metadata) => { metadata.packages[0].manifest_path = '/moved/Cargo.toml'; },
    (metadata) => { metadata.resolve.nodes = []; },
  ]) {
    const f = backportFixture();
    try {
      mutate(f.metadata);
      assert.throws(() => f.verify(), /Cargo metadata/);
    } finally { f.cleanup(); }
  }
});

test('build failures, a passing control, wrong crashes and changed executables are not runtime proof', () => {
  for (const mutate of [
    (f) => { f.runtime.control.status = 0; f.runtime.control.signal = null; },
    (f) => { f.runtime.control.status = 101; f.runtime.control.signal = null; },
    (f) => { f.runtime.control.signal = 'SIGABRT'; },
    (f) => { f.runtime.control.stdout = ''; },
    (f) => { f.runtime.patched.status = 101; },
    (f) => writeFileSync(join(f.work, 'patched-target/release/glib-backport-regression'), 'changed'),
    (f) => rmSync(join(f.work, 'control-target/release/glib-backport-regression')),
    (f) => writeFileSync(join(f.work, 'control/src/variant_iter.rs'), 'not the original source'),
    (f) => writeFileSync(join(f.work, 'patched/regression/Cargo.lock'), 'different dependencies'),
  ]) {
    const f = backportFixture();
    try {
      mutate(f);
      assert.throws(() => f.verify());
    } finally { f.cleanup(); }
  }
});

test('only branded verified exact glib evidence receives a visible backport classification', () => {
  const f = backportFixture();
  try {
    const evidence = f.verify();
    const proofNow = f.proof.createdAt;
    const result = classifyRustAudit(glibReport(), [], proofNow, evidence);
    assert.equal(result.status, 'warning', 'never call the version finding clean');
    assert.equal(result.backported.length, 1);
    assert.equal(result.approved.length, 0, 'this is not renewed risk approval');
    assert.equal(result.blocking.length, 0);
    assert.throws(() => classifyRustAudit(glibReport(), [], proofNow, { ...evidence }), /Unverified/);
    assert.throws(() => classifyRustAudit(glibReport(), [], proofNow + 3600000, evidence), /stale/i);
    assert.throws(() => classifyRustAudit(glibReport(), [{ ...decision, id: evidence.id }], proofNow, evidence),
      /risk exemption/);
    const unrelated = glibReport();
    unrelated.vulnerabilities = report([finding()]).vulnerabilities;
    assert.equal(classifyRustAudit(unrelated, [], proofNow, evidence).status, 'failed');
    assert.equal(classifyRustAudit(report(), [], proofNow, evidence).status, 'failed');
    const registry = glibReport();
    registry.warnings.unsound[0].package.source = 'registry+https://github.com/rust-lang/crates.io-index';
    assert.equal(classifyRustAudit(registry, [], proofNow, evidence).status, 'failed');
    const older = glibReport();
    older.warnings.unsound[0].package.version = '0.18.4';
    assert.equal(classifyRustAudit(older, [], proofNow, evidence).status, 'failed');
    const duplicate = glibReport();
    duplicate.warnings.unsound.push(duplicate.warnings.unsound[0]);
    assert.equal(classifyRustAudit(duplicate, [], proofNow, evidence).status, 'failed');
  } finally { f.cleanup(); }
});

test('the audit runner requires source and runtime proof before any outage handling', () => {
  const f = backportFixture();
  try {
    let databaseCalls = 0;
    const run = (executable, args, options) => {
      if (executable === 'git') { databaseCalls++; return { status: 0 }; }
      if (executable === 'cargo' && args[0] === 'audit')
        return { status: 0, stdout: JSON.stringify(glibReport()) };
      return f.run(executable, args, options);
    };
    const result = runRustAudit({
      lockfile: join(f.root, 'src-tauri/Cargo.lock'), decisions: [], proofFile: f.proofFile,
      now: f.proof.createdAt, env: f.env, run,
    });
    assert.equal(result.status, 'warning');
    assert.equal(result.failed, false);
    assert.equal(databaseCalls, 1);
    assert.throws(() => runRustAudit({
      lockfile: join(f.root, 'src-tauri/Cargo.lock'), decisions: [], proofFile: '',
      now: f.proof.createdAt, env: f.env, run,
    }), /missing.*proof/);
    assert.equal(databaseCalls, 1, 'a proof failure must not become a database outage');
  } finally { f.cleanup(); }
});

test('source or proof changed during the database/audit boundary cannot reuse verified evidence', () => {
  for (const mutate of [
    (f) => writeFileSync(join(f.root, GLIB_BACKPORT.path, 'LICENSE'), 'changed during audit'),
    (f) => rmSync(f.proofFile),
    (f) => writeFileSync(join(f.work, 'patched-target/release/glib-backport-regression'), 'changed during audit'),
  ]) {
    const f = backportFixture();
    try {
      assert.throws(() => runRustAudit({
        lockfile: join(f.root, 'src-tauri/Cargo.lock'), decisions: [], proofFile: f.proofFile,
        now: f.proof.createdAt, env: f.env,
        run: (executable, args, options) => {
          if (executable === 'git') { mutate(f); return { status: 0 }; }
          if (executable === 'cargo' && args[0] === 'audit')
            return { status: 0, stdout: JSON.stringify(glibReport()) };
          return f.run(executable, args, options);
        },
      }));
    } finally { f.cleanup(); }
  }
});
