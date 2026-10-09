# glib 0.18.5 source backport

This is the complete published glib 0.18.5 crate, with its original version,
COPYRIGHT, and MIT LICENSE preserved. `BACKPORT.json` records immutable archive
and upstream fix identities. The only changes to published crate files are
`let p` to `let mut p` and `&p` to `&mut p` in `src/variant_iter.rs`.
The resulting complete iterator file is identical to upstream merge
`05dff0ee696f9bcd8617cd48c4b812d046d440cb`.

Upstream fix: https://github.com/gtk-rs/gtk-rs-core/pull/1343
Advisory: https://rustsec.org/advisories/RUSTSEC-2024-0429.html

This is not an upstream release or a risk exemption. RustSec still reports
version 0.18.5 as affected. The audit retains that finding as a visible,
source-verified backport only after verifying the exact whole-tree pin,
path-based Cargo resolution, and a fresh compiled optimized regression proof.
No proof means a failed audit, not a clean result.

`.github/scripts/verify-glib-backport.mjs` downloads and checksum-verifies the
original archive as its control, compares every published file against this
copy (allowing only the two-line patch), compiles the same regression and
dependency lock for both sources with release optimization, and executes both
binaries. The control must start the regression and terminate with SIGSEGV;
the patched binary must pass next, nth, last, next_back, and nth_back checks.
A build error or an original binary that passes is not acceptable evidence.

The fresh proof is written outside the source tree to `GLIB_BACKPORT_PROOF`,
bound to source/config/manifest/lock/verifier hashes and the current GitHub
commit, run ID, and attempt. The audit checks the binary hashes and repeats
both executions before classifying this one finding. All other findings
remain subject to the ordinary audit policy.

The added `regression/` program and these two BACKPORT files are local
verification/provenance material, not changes to the published crate API.
