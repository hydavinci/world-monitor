import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { StatusPanel, type DigestCoverageSummary } from '@/components/StatusPanel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function coverage(state: DigestCoverageSummary['state']): DigestCoverageSummary {
  return {
    state,
    itemsServed: 12,
    publisherCount: 4,
    feedsCompleted: 7,
    feedsTotal: 8,
    categoriesCompleted: 3,
    categoriesTotal: 4,
    missingCategories: state === 'partial' ? ['tech'] : [],
  };
}

describe('StatusPanel digest coverage row', () => {
  it.each(['complete', 'partial', 'stale', 'unavailable'] as const)(
    'preserves the %s state for diagnostics without rendering a footer row',
    (state) => {
      const panel = new StatusPanel();
      panel.updateDigestCoverage(coverage(state));

      const row = panel.getElement().querySelector<HTMLElement>('.digest-coverage-row');
      expect(row).toBeNull();
      expect(panel.getDigestCoverage()).toEqual(coverage(state));
    },
  );
});

describe('StatusPanel does not recreate the removed dashboard footer', () => {
  it('does not mount diagnostics into an existing footer', () => {
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    document.body.appendChild(footer);

    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('partial'));

    const row = document.querySelector<HTMLElement>('.digest-coverage-row');
    expect(row).toBeNull();
    expect(footer.children).toHaveLength(0);
    expect(panel.getDigestCoverage()).toEqual(coverage('partial'));
  });

  it('does not double-mount across repeated coverage updates', () => {
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    document.body.appendChild(footer);

    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('partial'));
    panel.updateDigestCoverage(coverage('complete'));

    expect(document.querySelectorAll('.status-panel-container')).toHaveLength(0);
    expect(document.querySelectorAll('.digest-coverage-row')).toHaveLength(0);
    expect(panel.getDigestCoverage()).toEqual(coverage('complete'));
  });

  it('keeps the latest coverage data when no footer exists', () => {
    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('stale'));

    expect(document.querySelector('.digest-coverage-row')).toBeNull();
    expect(panel.getElement().querySelector('.digest-coverage-row')).toBeNull();
    expect(panel.getDigestCoverage()).toEqual(coverage('stale'));
  });
});
