export const SUPPORTED_EXPORT_FORMATS = ['csv', 'json', 'pdf'] as const;
export type DataExportFormat = (typeof SUPPORTED_EXPORT_FORMATS)[number];
export type TabCapVerdict = { allowed: true; cap: null; pendingActivation: false };
