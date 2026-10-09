import type { AccessContextSnapshot } from '@/services/webmcp';
export function getWebMcpAccessContext(options: {
  enabledPanelUsed: number; dashboardTabCount: number;
}): AccessContextSnapshot {
  return {
    mode: 'public',
    capabilities: { dataExport: true },
    limits: {
      enabledPanels: { used: options.enabledPanelUsed, cap: null },
      dashboardTabs: { used: options.dashboardTabCount, cap: null, canCreate: true },
    },
  };
}
