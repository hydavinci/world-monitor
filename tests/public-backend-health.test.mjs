import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';

const retired = [
  'nationalDebt', 'sanctionsPressure', 'companyMonitoringWorker',
  'physicalPremiums', 'physicalDivergence', 'mineralProduction',
  'globalTenders', 'globalTendersSam', 'globalTendersTed',
  'globalTendersContractsFinder', 'globalTendersCanadaBuys',
  'globalTendersGets', 'globalTendersWorldBank', 'supplyVulnerability',
  'supplyChokepointDependencies', 'comtradeBilateralHs4', 'foodStocks',
  'demographicsCapability', 'regionalSnapshots', 'regionalBriefs',
  'digestNotifications', 'scorecardFiveFactor', 'productCatalog',
];

test('public health no longer monitors retired storage and workers', () => {
  for (const name of retired) {
    for (const registry of [__testing__.BOOTSTRAP_KEYS, __testing__.STANDALONE_KEYS, __testing__.SEED_META]) {
      assert.equal(Object.hasOwn(registry, name), false, name);
    }
    assert.equal(__testing__.ON_DEMAND_KEYS.has(name), false, name);
  }
  for (const name of ['sanctionsEntities', 'minerals', 'resilienceRanking', 'resilienceIntervals']) {
    assert.ok(__testing__.BOOTSTRAP_KEYS[name] ?? __testing__.STANDALONE_KEYS[name],
      `retain independent public ${name} monitoring`);
  }
});

test('operator seed health does not request retired metadata', () => {
  const source = readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');
  for (const key of [
    'market:physical-premium', 'market:physical-divergence',
    'supply-chain:mineral-production', 'comtrade:bilateral-hs4',
    'supply-chain:vulnerability', 'supply-chain:chokepoint-dependencies',
    'sanctions:pressure', 'resilience:food-stocks', 'demographics:capability',
    'product-catalog', 'intelligence:regional-briefs',
  ]) {
    assert.equal(source.includes(`'${key}':`), false, key);
  }
});
