#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';
import {
  acknowledgeStaticRefHeavyTurn,
  claimStaticRefHeavyTurn,
  orderStaticRefHeavySections,
} from './_static-ref-heavy-order.mjs';

// The heavy half of static-ref (#6806). The three rotated members are
// low-cadence but expensive, and leftover's 570s tick could not hold them
// alongside the light members. The daily Supply-Vulnerability projection
// shares the lead position on alternating ticks with the rotated heavy members.
// Military-Bases and the projection cannot fit at their combined worst case,
// so this two-tick fairness rule is what bounds either member's deferral.
//
// ONE service, not three. Railway kills a cron container at 10 minutes, so the
// budget is 570s and no arrangement can run Arms-Suppliers (380s worst case)
// and Military-Bases (410s) in the SAME tick. But "cannot share a tick" is not
// "cannot share a bundle": the runner defers the loser to the next daily tick,
// and at 14-day and 30-day cadences a one-day deferral costs nothing. Three
// 1-section services would have bought the same isolation at 3x the Railway
// service budget, which is capped at 100 and already at 81.
//
// Heavy ordering ROTATES because a member that never publishes never stops
// being due.
// That is not hypothetical here: Arms-Suppliers has never written
// seed-meta:military:arms-suppliers-complete, so a fixed order would hand it
// the first slot every single day and reproduce, inside this bundle, the exact
// starvation that made it necessary. seed-bundle-macro.mjs uses the same device
// for the same reason (its education member gets first priority one UTC day a
// week). With three members on a daily tick, each one leads every third day —
// far more often than any of these cadences needs, so a permanently failing
// member can consume at most one heavy lead slot in three. The daily projection
// leads every other tick, so a permanently due Military-Bases run cannot starve
// it past the two-day health budget (and the inverse cannot happen either).
const SECTIONS = [
  // Missing canonicalKey is intentional (#6845); do not invent one here.
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 400_000 },
];

const DAILY_SECTIONS = [
];

// The Redis turn advances once per actual invocation. Calendar parity is not a
// safe substitute: if Railway misses a day, two executions can have the same
// parity and repeat the same lead class.
//
// A null claim is NOT a crash. claimStaticRefHeavyTurn collapses three cases into
// null — another run legitimately holds the lease, credentials are absent, and any
// transient Upstash failure (including its 5s timeout). Throwing here skipped all
// four members for the whole daily tick on what is often a momentary blip, which
// is far more damaging than deferring one rotation. Not advancing the turn also
// preserves the anti-bias property the rotation exists for: the next invocation
// claims the same turn, so no cadence class is skipped. Mirrors the graceful
// `process.exit(0)` that _seed-utils.mjs already uses for lock contention.
const turnClaim = await claimStaticRefHeavyTurn();
if (turnClaim == null) {
  console.log(
    '[Bundle:static-ref-heavy] could not claim the durable scheduler turn '
    + '(lease held by another run, or Redis unavailable) — deferring to the next tick.',
  );
  process.exit(0);
}
const sections = orderStaticRefHeavySections(SECTIONS, DAILY_SECTIONS, turnClaim.turn);

console.log(
  `[Bundle:static-ref-heavy] turn ${turnClaim.turn} — order: ${sections.map((s) => s.label).join(' -> ')}`,
);

await runBundle('static-ref-heavy', sections, {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work
  // and the terminal reason in logs.
  maxBundleMs: 570_000,
  // Advance after every fully completed tick, including a non-zero tick, so a
  // failing lead member cannot take the same slot forever. A killed or
  // early-aborted process never reaches this hook and safely repeats the turn
  // after the lease expires.
  onTerminalComplete: async () => {
    if (!await acknowledgeStaticRefHeavyTurn(turnClaim)) {
      throw new Error(`could not acknowledge scheduler turn ${turnClaim.turn}`);
    }
  },
});
