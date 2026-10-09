import { loadFromStorage,saveToStorage } from '@/utils';
import { clearPanelColSpanEntry,clearPanelSpanEntry } from '@/utils/panel-storage';

const STORAGE_KEY = 'wm-custom-widgets';
const CHANGED_EVENT = 'wm-custom-widgets-changed';
export interface CustomWidgetSpec {
  id: string;
  title: string;
  html: string;
  prompt: string;
  tier: 'basic';
  accentColor: string | null;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
  updatedAt: number;
}

export function loadWidgets(): CustomWidgetSpec[] {
  const stored = loadFromStorage<unknown>(STORAGE_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is CustomWidgetSpec => !!item && typeof item.id === 'string'
    && typeof item.html === 'string' && item.tier !== 'pro')
    .map(item => ({ ...item, tier: 'basic' }));
}

export async function saveWidget(spec: CustomWidgetSpec): Promise<void> {
  const { sanitizeWidgetHtml } = await import('@/utils/widget-sanitizer');
  const next = { ...spec, tier: 'basic' as const, html: sanitizeWidgetHtml(spec.html.slice(0, 50_000)),
    conversationHistory: spec.conversationHistory.slice(-10) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...loadWidgets().filter(w => w.id !== spec.id), next].slice(-10)));
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function deleteWidget(id: string): void {
  saveToStorage(STORAGE_KEY, loadWidgets().filter(widget => widget.id !== id));
  clearPanelSpanEntry(id);
  clearPanelColSpanEntry(id);
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function subscribeWidgets(handler: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY || event.key === null) handler();
  };
  window.addEventListener(CHANGED_EVENT, handler);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, handler);
    window.removeEventListener('storage', onStorage);
  };
}

export function getWidget(id: string): CustomWidgetSpec | null {
  return loadWidgets().find(widget => widget.id === id) ?? null;
}
