#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

export const GLIB_BACKPORT = Object.freeze({
  id: 'RUSTSEC-2024-0429',
  version: '0.18.5',
  path: 'src-tauri/vendor/glib-0.18.5',
  archive: 'https://static.crates.io/crates/glib/glib-0.18.5.crate',
  archiveSha256: '233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5',
  originalFileSha256: '1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e',
  sourceTreeSha256: '2a8d9797d478d14cfcb14f163c0d2ab19180a3910a49104009c24f84b2d0b3a8',
  configSha256: '5efcea1ab2dae73cd1d60b9ee06bf14e40f90c53aee101ca299b8145bc49efd5',
});
const verified = new WeakMap();
export const isVerifiedGlibBackport = (value) => verified.has(value);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => hash(readFileSync(path));
const requireCondition = (ok, message) => {
  if (!ok) throw new Error(`glib backport: ${message}`);
};
const script = fileURLToPath(import.meta.url);

function treeFiles(root, relative = '') {
  return readdirSync(join(root, relative)).sort().flatMap((name) => {
    const path = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, path));
    requireCondition(!stat.isSymbolicLink(), `symlink is not pinned: ${path}`);
    if (stat.isDirectory()) return treeFiles(root, path);
    requireCondition(stat.isFile(), `non-file in vendor tree: ${path}`);
    return [[path, fileHash(join(root, path))]];
  });
}
export function glibSourceContract(root) {
  root = resolve(root);
  const vendor = join(root, GLIB_BACKPORT.path);
  requireCondition(realpathSync(vendor) === join(realpathSync(root), GLIB_BACKPORT.path),
    'vendor path must not be redirected by a symlink');
  requireCondition(fileHash(join(root, 'src-tauri/.cargo/config.toml')) === GLIB_BACKPORT.configSha256,
    'Cargo source config changed');
  for (const path of ['.cargo/config', '.cargo/config.toml', '.cargo/config.local.toml',
    'src-tauri/.cargo/config', 'src-tauri/.cargo/config.local.toml'])
    requireCondition(!existsSync(join(root, path)), `unverified Cargo config: ${path}`);
  const sourceTreeSha256 = hash(JSON.stringify(treeFiles(vendor)));
  requireCondition(sourceTreeSha256 === GLIB_BACKPORT.sourceTreeSha256, 'whole-source tree mismatch');
  const manifest = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const patches = [...manifest.matchAll(/^\[patch\.crates-io\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)];
  requireCondition(patches.length === 1 && patches[0][1].trim() === 'glib = { path = "vendor/glib-0.18.5" }',
    'expected exact path-based crates.io patch');
  const lock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
  const packages = lock.split(/^\[\[package\]\]\s*$/m)
    .filter((part) => /^name\s*=\s*"glib"\s*$/m.test(part));
  requireCondition(packages.length === 1 && /^version = "0\.18\.5"\s*$/m.test(packages[0])
    && !/^(source|checksum)\s*=/m.test(packages[0]), 'lock must contain exactly one path glib 0.18.5');
  return {
    sourceTreeSha256,
    manifestSha256: hash(manifest),
    lockSha256: hash(lock),
    configSha256: GLIB_BACKPORT.configSha256,
    verifierSha256: fileHash(script),
    auditSha256: fileHash(join(root, '.github/scripts/audit-rust-dependencies.mjs')),
    workflowSha256: fileHash(join(root, '.github/workflows/security-audit.yml')),
  };
}

function ciIdentity(env) {
  requireCondition(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    && /^\d+$/.test(env.GITHUB_RUN_ID || '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT || ''),
  'proof requires current GitHub commit, run ID and attempt');
  return { sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
}
function cargoEnv(work, target) {
  // Do not inherit Rust flags, wrappers, profile overrides or machine Cargo config.
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    CARGO_HOME: join(work, 'cargo-home'), CARGO_TARGET_DIR: target,
    RUSTFLAGS: '', CARGO_ENCODED_RUSTFLAGS: '',
  };
}
function command(run, executable, args, work, target, inherit = false) {
  const result = run(executable, args, {
    cwd: work, env: cargoEnv(work, target), encoding: 'utf8',
    timeout: 600000, maxBuffer: 32 * 1024 * 1024,
    ...(inherit ? { stdio: 'inherit' } : {}),
  });
  if (result.error) throw result.error;
  requireCondition(result.status === 0, `${executable} ${args.join(' ')} failed: ${result.stderr || result.status}`);
  return result.stdout;
}
function cargoSource(run, root, work) {
  for (const name of ['config', 'config.toml'])
    requireCondition(!existsSync(join(work, 'cargo-home', name)), 'proof Cargo home has an unverified config');
  const metadata = JSON.parse(command(run, 'cargo', [
    'metadata', '--locked', '--format-version', '1', '--manifest-path', join(root, 'src-tauri/Cargo.toml'),
  ], work, join(work, 'metadata-target')));
  const glib = metadata.packages.filter((pkg) => pkg.name === 'glib');
  requireCondition(glib.length === 1 && glib[0].version === GLIB_BACKPORT.version
    && glib[0].source === null
    && glib[0].manifest_path === join(root, GLIB_BACKPORT.path, 'Cargo.toml')
    && metadata.resolve?.nodes.some((node) => node.id === glib[0].id),
  'Cargo metadata did not resolve exactly the pinned path glib');
  return glib[0].id;
}
function executeRegression(run, binary, control, work) {
  const result = run(binary, [], {
    cwd: work, env: cargoEnv(work, join(work, 'runtime-target')),
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  requireCondition(result.stdout?.startsWith('glib-backport-regression-start\n'),
    `${control ? 'control' : 'patched'} did not start the Rust regression`);
  if (control) requireCondition(result.status === null && result.signal === 'SIGSEGV',
    'optimized original must reproduce SIGSEGV; passing or other failures are not proof');
  else requireCondition(result.status === 0 && !result.signal
    && result.stdout === 'glib-backport-regression-start\nglib-backport-regression-ok\n',
  'optimized patched regression failed');
  return { status: result.status, signal: result.signal || null, stdout: result.stdout };
}

function compiledSourceInputs(root, work, fixtureLockSha256) {
  const vendorFiles = treeFiles(join(root, GLIB_BACKPORT.path));
  for (const role of ['control', 'patched']) {
    const expected = new Map(vendorFiles.filter(([path]) =>
      role !== 'control' || !['BACKPORT.json', 'BACKPORT.md'].includes(path)));
    if (role === 'control') expected.set('src/variant_iter.rs', GLIB_BACKPORT.originalFileSha256);
    requireCondition(/^[a-f0-9]{64}$/.test(fixtureLockSha256 || ''), 'missing compiled fixture lock hash');
    expected.set('regression/Cargo.lock', fixtureLockSha256);
    const actual = treeFiles(join(work, role));
    requireCondition(actual.length === expected.size
      && actual.every(([path, checksum]) => expected.get(path) === checksum),
    `${role} compiled source/dependency lock changed or missing`);
  }
}

export function verifyGlibBackport({
  root, proofFile, now = Date.now(), env = process.env, run = spawnSync,
}) {
  const contract = glibSourceContract(root);
  requireCondition(proofFile, 'missing compiled regression proof (GLIB_BACKPORT_PROOF)');
  const proofBytes = readFileSync(proofFile);
  const proof = JSON.parse(proofBytes);
  const identity = ciIdentity(env);
  requireCondition(proof.schema === 1 && proof.advisory === GLIB_BACKPORT.id
    && proof.version === GLIB_BACKPORT.version, 'wrong proof schema/advisory/version');
  for (const [key, value] of Object.entries(contract))
    requireCondition(proof.contract?.[key] === value, `proof no longer matches ${key}`);
  requireCondition(Object.entries(identity).every(([key, value]) => proof.ci?.[key] === value),
    'proof belongs to a different commit/run/attempt');
  requireCondition(Number.isFinite(proof.createdAt) && now >= proof.createdAt && now - proof.createdAt < 3600000,
    'compiled regression proof is missing or stale');
  const work = resolve(proof.work || '');
  requireCondition(dirname(work) === dirname(resolve(proofFile))
    && work.startsWith(join(dirname(resolve(proofFile)), 'ci-glib-regression-')),
  'unexpected proof artifact directory');
  requireCondition(proof.optimization === 3 && proof.controlBuild === 0 && proof.patchedBuild === 0,
    'proof must include successful optimized builds of both sources');
  compiledSourceInputs(resolve(root), work, proof.fixtureLockSha256);
  const compiler = command(run, 'rustc', ['-Vv'], work, join(work, 'metadata-target'));
  requireCondition(proof.compiler === compiler && /host: .*linux/.test(compiler),
    'proof compiler/host mismatch');
  const packageId = cargoSource(run, resolve(root), work);
  requireCondition(proof.packageId === packageId, 'proof Cargo resolution changed');
  for (const role of ['control', 'patched']) {
    const binary = join(work, `${role}-target/release/glib-backport-regression`);
    requireCondition(proof.binaries?.[role] === fileHash(binary), `${role} executable changed or missing`);
    const result = executeRegression(run, binary, role === 'control', work);
    requireCondition(JSON.stringify(proof.runtime?.[role]) === JSON.stringify(result),
      `${role} runtime proof changed`);
  }
  const evidence = Object.freeze({
    id: GLIB_BACKPORT.id, version: GLIB_BACKPORT.version,
    sourceTreeSha256: contract.sourceTreeSha256,
    ci: identity, createdAt: proof.createdAt, proofFile: resolve(proofFile),
  });
  verified.set(evidence, {
    root: resolve(root), contract, work, proofSha256: hash(proofBytes),
    fixtureLockSha256: proof.fixtureLockSha256, binaries: proof.binaries,
  });
  return evidence;
}

export function assertGlibBackportCurrent(evidence, now) {
  const inputs = verified.get(evidence);
  requireCondition(inputs, 'unverified compiled evidence');
  requireCondition(now >= evidence.createdAt && now - evidence.createdAt < 3600000,
    'stale compiled evidence');
  requireCondition(JSON.stringify(glibSourceContract(inputs.root)) === JSON.stringify(inputs.contract),
    'source/config/lock changed after regression verification');
  requireCondition(fileHash(evidence.proofFile) === inputs.proofSha256,
    'runtime proof changed after verification');
  compiledSourceInputs(inputs.root, inputs.work, inputs.fixtureLockSha256);
  for (const role of ['control', 'patched'])
    requireCondition(fileHash(join(inputs.work, `${role}-target/release/glib-backport-regression`))
      === inputs.binaries[role], `${role} executable changed after verification`);
}

export async function produceGlibBackportProof({ root, proofFile, env = process.env, run = spawnSync }) {
  requireCondition(proofFile, 'missing proof output path (GLIB_BACKPORT_PROOF)');
  rmSync(proofFile, { force: true }); // Never retain a successful proof after a failed rerun.
  const contract = glibSourceContract(root);
  const ci = ciIdentity(env);
  requireCondition(process.platform === 'linux', 'compiled proof requires the Linux CI runner');
  mkdirSync(dirname(resolve(proofFile)), { recursive: true });
  const work = mkdtempSync(join(dirname(resolve(proofFile)), 'ci-glib-regression-'));
  const response = await fetch(GLIB_BACKPORT.archive);
  requireCondition(response.ok, `control archive fetch failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  requireCondition(hash(archive) === GLIB_BACKPORT.archiveSha256, 'control archive checksum mismatch');
  writeFileSync(join(work, 'glib.crate'), archive);
  mkdirSync(join(work, 'control'));
  command(run, 'tar', ['-xzf', join(work, 'glib.crate'), '--strip-components=1', '-C', join(work, 'control')],
    work, join(work, 'metadata-target'));
  const vendor = join(root, GLIB_BACKPORT.path);
  const originalFiles = treeFiles(join(work, 'control'));
  requireCondition(originalFiles.length === 121, 'unexpected original archive files');
  for (const [path, checksum] of originalFiles) {
    const expected = path === 'src/variant_iter.rs'
      ? 'a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc' : checksum;
    requireCondition(fileHash(join(vendor, path)) === expected, `published source changed: ${path}`);
  }
  requireCondition(fileHash(join(work, 'control/src/variant_iter.rs')) === GLIB_BACKPORT.originalFileSha256,
    'control is not the original vulnerable source');
  cpSync(vendor, join(work, 'patched'), { recursive: true });
  cpSync(join(vendor, 'regression'), join(work, 'control/regression'), { recursive: true });
  command(run, 'cargo', ['generate-lockfile', '--manifest-path', join(work, 'control/regression/Cargo.toml')],
    work, join(work, 'control-target'), true);
  cpSync(join(work, 'control/regression/Cargo.lock'), join(work, 'patched/regression/Cargo.lock'));
  const compiler = command(run, 'rustc', ['-Vv'], work, join(work, 'metadata-target'));
  const binaries = {}, runtime = {};
  for (const role of ['control', 'patched']) {
    command(run, 'cargo', ['build', '--release', '--locked', '--manifest-path',
      join(work, role, 'regression/Cargo.toml')], work, join(work, `${role}-target`), true);
    const binary = join(work, `${role}-target/release/glib-backport-regression`);
    binaries[role] = fileHash(binary);
    runtime[role] = executeRegression(run, binary, role === 'control', work);
  }
  const packageId = cargoSource(run, resolve(root), work);
  const fixtureLockSha256 = fileHash(join(work, 'control/regression/Cargo.lock'));
  compiledSourceInputs(resolve(root), work, fixtureLockSha256);
  requireCondition(JSON.stringify(glibSourceContract(root)) === JSON.stringify(contract),
    'source/config/lock changed during compilation');
  writeFileSync(proofFile, `${JSON.stringify({
    schema: 1, advisory: GLIB_BACKPORT.id, version: GLIB_BACKPORT.version,
    contract, ci, work, compiler, packageId, fixtureLockSha256, optimization: 3,
    controlBuild: 0, patchedBuild: 0, binaries, runtime, createdAt: Date.now(),
  }, null, 2)}\n`, { flag: 'wx' });
  console.log(`Verified optimized original SIGSEGV and patched success; proof: ${proofFile}`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await produceGlibBackportProof({ root: resolve('.'), proofFile: process.env.GLIB_BACKPORT_PROOF });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
