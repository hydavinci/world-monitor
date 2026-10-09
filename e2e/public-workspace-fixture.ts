export function publicPanelsWorkspaceStorage(variant: string): Record<string, string> {
  const id = 'tab-public-panels';
  return {
    [`worldmonitor-tabs-v1:${variant}`]: JSON.stringify({
      activeTabId: id,
      tabs: [{
        id,
        name: 'Public Dashboard',
        view: 'panels',
        panelSettings: {},
        panelOrder: [],
        bottomSet: [],
      }],
    }),
  };
}
