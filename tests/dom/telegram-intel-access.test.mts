import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
const state = vi.hoisted(() => ({
  desktop: false,
  premium: false,
  feed: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('@/services/runtime', async () => ({
  ...(await vi.importActual<typeof import('@/services/runtime')>(
    '@/services/runtime',
  )),
  isDesktopRuntime: () => state.desktop,
}));
vi.mock('@/services/telegram-intel', async () => ({
  ...(await vi.importActual<typeof import('@/services/telegram-intel')>(
    '@/services/telegram-intel',
  )),
  fetchTelegramChannelFeed: state.feed,
  fetchTelegramChannelPreview: state.preview,
}));
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import { TELEGRAM_WATCHLIST_EVENT } from '@/services/telegram-watchlist';
const empty = {
  source: 'telegram',
  earlySignal: true,
  enabled: true,
  count: 0,
  updatedAt: null,
  items: [],
};
const item = {
  id: 'test_channel:1',
  source: 'telegram' as const,
  channel: 'test_channel',
  channelTitle: 'Test',
  url: 'https://t.me/test_channel/1',
  ts: '2026-09-16T00:00:00Z',
  text: 'Protected fixture',
  topic: 'osint',
  tags: [],
  earlySignal: true,
};
const panels: TelegramIntelPanel[] = [];
function panel() {
  const p = new TelegramIntelPanel();
  panels.push(p);
  document.body.append(p.getElement());
  return p;
}
function watchlist() {
  window.dispatchEvent(
    new CustomEvent(TELEGRAM_WATCHLIST_EVENT, {
      detail: { entries: [{ username: 'test_channel' }] },
    }),
  );
}
function type(p: TelegramIntelPanel) {
  const input = p.getElement().querySelector<HTMLInputElement>('input')!;
  input.value = 'test_channel';
  input.dispatchEvent(new Event('input'));
}
beforeAll(initTestI18n);
afterEach(() => {
  panels.splice(0).forEach((p) => p.destroy());
  vi.useRealTimers();
  state.desktop = false;
  state.premium = false;
  state.feed.mockReset();
  state.preview.mockReset();
  localStorage.clear();
  document.body.innerHTML = '';
});
describe('Telegram access lifecycle', () => {
  it('does not start watchlist work before an enabled base feed', async () => {
    state.feed.mockResolvedValue(empty);
    panel();
    watchlist();
    await Promise.resolve();
    expect(state.feed).not.toHaveBeenCalled();
  });
  it('does not fetch or render on free desktop even before layout has locked it', async () => {
    vi.useFakeTimers();
    state.desktop = true;
    state.feed.mockResolvedValue(empty);
    const p = panel();
    p.setData({ ...empty, items: [item] });
    watchlist();
    type(p);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.feed).not.toHaveBeenCalled();
    expect(state.preview).not.toHaveBeenCalled();
    expect(p.getElement().textContent).not.toContain(item.text);
  });
});
