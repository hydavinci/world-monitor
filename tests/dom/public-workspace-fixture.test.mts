import { beforeEach, expect, it } from 'vitest';
import { loadTabsState } from '@/services/tab-store';
import { publicPanelsWorkspaceStorage } from '../../e2e/public-workspace-fixture';

beforeEach(() => localStorage.clear());

it('loads the browser regression workspace as panels while preserving live local preferences', () => {
  const panels = '{"weather":{"name":"Weather","enabled":true,"priority":1}}';
  localStorage.setItem('worldmonitor-panels', panels);
  localStorage.setItem('panel-order', '["weather"]');
  for (const [key, value] of Object.entries(publicPanelsWorkspaceStorage('full'))) localStorage.setItem(key, value);

  const state = loadTabsState();
  expect(state?.tabs).toHaveLength(1);
  expect(state?.activeTabId).toBe('tab-public-panels');
  expect(state?.tabs[0]?.view).toBe('panels');
  expect(localStorage.getItem('worldmonitor-panels')).toBe(panels);
  expect(localStorage.getItem('panel-order')).toBe('["weather"]');
});
