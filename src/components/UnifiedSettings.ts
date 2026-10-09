import { confirmDialog } from '@/components/confirm-dialog';
import { createSettingsButton } from '@/components/settings-button';
import type { MapProvider } from '@/config/basemap';
import { ALL_PANELS,getEffectivePanelConfig,getVariantPanelCategories,PANEL_CATEGORY_MAP } from '@/config/panels';
import { getTheaterPreset,getTheaterPresetEnableList,resolveTheaterPresetSources,THEATER_PRESETS } from '@/config/theater-presets';
import { showToast } from '@/utils/toast';
import { SITE_VARIANT } from '@/config/variant';
import { FONT_SCALE_STEPS,fontScaleLabel,parseFontScale } from '@/services/font-scale-settings';
import { t } from '@/services/i18n';
import { renderPreferences } from '@/services/preferences-content';
import { sanitizePublicPanelSettings } from '@/services/public-preferences';
import type { PanelConfig } from '@/types';
import { setTrustedHtml,trustedHtml } from '@/utils/dom-utils';
import { createFocusTrap,type FocusTrap } from '@/utils/focus-trap';
import { declareOverlay } from '@/utils/open-modal';
import { overlayHistory,type OverlayCloseOrigin } from '@/utils/overlay-history';
import { escapeHtml } from '@/utils/sanitize';

export interface UnifiedSettingsConfig {
  getPanelSettings: () => Record<string, PanelConfig>;
  savePanelSettings: (panels: Record<string, PanelConfig>) => void;
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  getLocalizedPanelName: (key: string, fallback: string) => string;
  resetLayout: () => void;
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  onSourcesChanged?: () => void;
}

type TabId = 'settings' | 'panels' | 'sources';

/** Local preferences and public source selection, with no remote account state. */
export class UnifiedSettings {
  private overlay: HTMLElement;
  private focusTrap: FocusTrap;
  private activeTab: TabId = 'settings';
  private draftPanelSettings: Record<string, PanelConfig> = {};
  private prefsCleanup: (() => void) | null = null;
  private sourceSelectionBaseline: string | null = null;
  private historyRegistered = false;
  private filter = '';
  private category = 'all';
  private escapeHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      void this.requestClose();
    }
  };

  constructor(private config: UnifiedSettingsConfig) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    declareOverlay(this.overlay, { reload: 'blocking' });
    this.overlay.id = 'unifiedSettingsModal';
    this.overlay.style.display = 'none';
    document.body.appendChild(this.overlay);
    this.focusTrap = createFocusTrap(this.overlay);
    document.addEventListener('keydown', this.escapeHandler);
  }

  private sourceSignature(): string {
    return [...this.config.getDisabledSources()].sort().join('\n');
  }

  open(tab: string = 'settings', _options?: unknown): void {
    this.activeTab = tab === 'panels' || tab === 'sources' ? tab : 'settings';
    if (this.isOpen()) {
      this.render();
      return;
    }
    this.draftPanelSettings = structuredClone(sanitizePublicPanelSettings(this.config.getPanelSettings()));
    this.sourceSelectionBaseline = this.sourceSignature();
    this.overlay.style.display = 'flex';
    this.overlay.classList.add('active');
    this.render();
    this.focusTrap.activate();
    if (!this.historyRegistered) {
      overlayHistory.open('settings', (origin) => this.close(origin));
      this.historyRegistered = true;
    }
  }

  isOpen(): boolean { return this.overlay.style.display !== 'none'; }

  close(origin?: OverlayCloseOrigin): void {
    if (!this.isOpen()) return;
    const sourcesChanged = this.sourceSelectionBaseline !== null && this.sourceSelectionBaseline !== this.sourceSignature();
    this.sourceSelectionBaseline = null;
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.overlay.style.display = 'none';
    this.overlay.classList.remove('active');
    this.focusTrap.deactivate();
    if (this.historyRegistered) {
      if (origin !== 'history') overlayHistory.close('settings');
      this.historyRegistered = false;
    }
    if (sourcesChanged) this.config.onSourcesChanged?.();
  }

  private async requestClose(): Promise<void> {
    if (this.hasPendingChanges() && !await confirmDialog({ message: t('settings.unsavedChanges') })) return;
    this.close();
  }

  destroy(): void {
    this.close();
    document.removeEventListener('keydown', this.escapeHandler);
    this.overlay.remove();
  }

  hasPendingChanges(): boolean {
    return JSON.stringify(this.draftPanelSettings) !== JSON.stringify(sanitizePublicPanelSettings(this.config.getPanelSettings()));
  }
  getButton(): HTMLButtonElement { return createSettingsButton(() => this.open()); }

  refreshPanelToggles(): void {
    if (!this.hasPendingChanges()) {
      this.draftPanelSettings = structuredClone(sanitizePublicPanelSettings(this.config.getPanelSettings()));
    }
    if (this.isOpen()) this.renderPanels();
  }

  private render(): void {
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    const prefs = renderPreferences({ isDesktopApp: this.config.isDesktopApp, onMapProviderChange: this.config.onMapProviderChange });
    setTrustedHtml(this.overlay, trustedHtml(`
      <div class="modal unified-settings-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('header.settings'))}">
        <div class="modal-header"><span class="modal-title">${t('header.settings')}</span>
          <button class="modal-close unified-settings-close" aria-label="${escapeHtml(t('common.close'))}">×</button></div>
        <div class="unified-settings-tabs" role="tablist">${(['settings', 'panels', 'sources'] as const).map(tab => `
          <button class="unified-settings-tab${tab === this.activeTab ? ' active' : ''}" role="tab" data-tab="${tab}"
            id="us-tab-${tab}" aria-controls="us-tab-panel-${tab}" aria-selected="${tab === this.activeTab}"
            tabindex="${tab === this.activeTab ? 0 : -1}">${t(tab === 'settings' ? 'header.tabSettings' : tab === 'panels' ? 'header.tabPanels' : 'header.tabSources')}</button>`).join('')}</div>
        <div class="unified-settings-body">
          <div id="us-tab-panel-settings" class="unified-settings-tab-panel${this.activeTab === 'settings' ? ' active' : ''}" role="tabpanel"
            aria-labelledby="us-tab-settings" ${this.activeTab !== 'settings' ? 'hidden' : ''}>${prefs.html}</div>
          <div id="us-tab-panel-panels" class="unified-settings-tab-panel${this.activeTab === 'panels' ? ' active' : ''}" role="tabpanel"
            aria-labelledby="us-tab-panels" ${this.activeTab !== 'panels' ? 'hidden' : ''}>
            <div class="panels-search"><input data-panel-search placeholder="${escapeHtml(t('header.filterPanels'))}" value="${escapeHtml(this.filter)}"></div>
            <div class="unified-settings-region-wrapper"><div class="us-panel-categories unified-settings-region-bar" id="usPanelCatBar"></div></div>
            <div class="us-panels-grid panel-toggle-grid" id="usPanelToggles"></div>
            <div class="panels-footer"><button data-save-panels class="panels-save-layout">${t('modals.story.save')}</button>
              <button data-reset-layout class="panels-reset-layout">${t('header.resetLayout')}</button></div>
          </div>
          <div id="us-tab-panel-sources" class="unified-settings-tab-panel${this.activeTab === 'sources' ? ' active' : ''}" role="tabpanel"
            aria-labelledby="us-tab-sources" ${this.activeTab !== 'sources' ? 'hidden' : ''}>
            <div class="sources-search"><input data-source-search placeholder="${escapeHtml(t('header.filterSources'))}"></div>
            <div class="unified-settings-presets" id="usCoveragePresets">
              ${THEATER_PRESETS.filter(p => resolveTheaterPresetSources(p, new Set(this.config.getAllSourceNames())).length > 0)
                .map(p => `<button class="unified-settings-region-pill unified-settings-preset-chip" data-preset-id="${p.id}"
                  title="${escapeHtml(t(p.descriptionKey))}">${escapeHtml(t(p.labelKey))}</button>`).join('')}</div>
            <div class="us-sources-grid sources-toggle-grid" id="usSourceToggles"></div>
            <div class="sources-footer"><span class="us-sources-counter sources-counter" id="usSourcesCounter"></span>
              <button class="sources-select-all" data-sources-all>${t('common.selectAll')}</button>
              <button class="sources-select-none" data-sources-none>${t('common.selectNone')}</button></div>
          </div>
        </div>
      </div>`, 'Public settings template; dynamic labels and values are escaped'));
    declareOverlay(this.overlay.querySelector('[role="dialog"]') as HTMLElement, { reload: 'blocking' });
    this.prefsCleanup = prefs.attach(this.overlay.querySelector('#us-tab-panel-settings') as HTMLElement);
    this.overlay.querySelector('.unified-settings-close')?.addEventListener('click', () => void this.requestClose());
    this.overlay.onclick = event => { if (event.target === this.overlay) void this.requestClose(); };
    this.overlay.querySelectorAll<HTMLElement>('[data-tab]').forEach(button => {
      button.onclick = () => { this.activeTab = button.dataset.tab as TabId; this.render(); };
      button.onkeydown = event => {
        const tabs: TabId[] = ['settings', 'panels', 'sources'];
        let index = tabs.indexOf(this.activeTab);
        if (event.key === 'ArrowRight') index = (index + 1) % 3;
        else if (event.key === 'ArrowLeft') index = (index + 2) % 3;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = 2;
        else return;
        event.preventDefault(); this.activeTab = tabs[index]!; this.render();
        this.overlay.querySelector<HTMLElement>(`[data-tab="${this.activeTab}"]`)?.focus();
      };
    });
    const search = this.overlay.querySelector<HTMLInputElement>('[data-panel-search]');
    if (search) search.oninput = () => { this.filter = search.value; this.renderPanels(); };
    this.overlay.querySelector('[data-save-panels]')?.addEventListener('click', () => {
      this.config.savePanelSettings(sanitizePublicPanelSettings(this.draftPanelSettings));
    });
    this.overlay.querySelector('[data-reset-layout]')?.addEventListener('click', () => this.config.resetLayout());
    const sourceSearch = this.overlay.querySelector<HTMLInputElement>('[data-source-search]');
    if (sourceSearch) sourceSearch.oninput = () => this.renderSources(sourceSearch.value);
    for (const [selector, enabled] of [['[data-sources-all]', true], ['[data-sources-none]', false]] as const) {
      this.overlay.querySelector(selector)?.addEventListener('click', () => {
        this.config.setSourcesEnabled(this.config.getAllSourceNames(), enabled);
        this.renderSources(sourceSearch?.value);
      });
    }
    const presets = this.overlay.querySelector<HTMLElement>('#usCoveragePresets');
    if (presets && !presets.children.length) presets.remove();
    else if (presets) presets.onclick = event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-preset-id]');
      const preset = button && getTheaterPreset(button.dataset.presetId!);
      if (!preset) return;
      const known = new Set(this.config.getAllSourceNames());
      const label = t(preset.labelKey);
      if (!resolveTheaterPresetSources(preset, known).length) {
        showToast(t('theaterPresets.unavailable', { preset: label }));
        return;
      }
      const sources = getTheaterPresetEnableList(preset, this.config.getDisabledSources(), known);
      if (!sources.length) {
        showToast(t('theaterPresets.alreadyApplied', { preset: label }));
        return;
      }
      const before = this.config.getDisabledSources().size;
      this.config.setSourcesEnabled(sources, true);
      if (before !== this.config.getDisabledSources().size) {
        this.renderSources();
        showToast(t('theaterPresets.applied', { preset: label, count: String(sources.length) }));
      }
    };
    this.renderPanels();
    this.renderSources();
  }

  private renderPanels(): void {
    const categories = this.overlay.querySelector<HTMLElement>('.us-panel-categories');
    if (categories) {
      const catalog = getVariantPanelCategories(this.draftPanelSettings, SITE_VARIANT);
      setTrustedHtml(categories, trustedHtml(['all', ...catalog.map(c => c.key)].map(key =>
        `<button data-panel-cat="${escapeHtml(key)}" class="unified-settings-region-pill${key === this.category ? ' active' : ''}">${escapeHtml(key === 'all' ? t('common.all') : t(catalog.find(c => c.key === key)?.labelKey ?? key))}</button>`).join(''), 'Escaped public panel category labels'));
      categories.onclick = (event: MouseEvent) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-panel-cat]');
        if (!button) return;
        this.category = button.dataset.panelCat!;
        this.renderPanels();
      };
    }
    const grid = this.overlay.querySelector('.us-panels-grid');
    if (!grid) return;
    const entries = Object.keys(this.draftPanelSettings).filter(key => {
      const config = ALL_PANELS[key];
      if (!config) return false;
      const category = PANEL_CATEGORY_MAP[this.category];
      const categoryAllowed = category && (!category.variants || category.variants.includes(SITE_VARIANT));
      return (this.category === 'all' || categoryAllowed && category.panelKeys.includes(key)) &&
        this.config.getLocalizedPanelName(key, config.name).toLowerCase().includes(this.filter.toLowerCase());
    });
    setTrustedHtml(grid, trustedHtml(entries.map(key => {
      const panel = this.draftPanelSettings[key]!;
      const effective = getEffectivePanelConfig(key, SITE_VARIANT);
      return `<div class="us-panel-item"><button class="us-panel-toggle panel-toggle-item${panel.enabled ? ' enabled active' : ''}" data-panel="${escapeHtml(key)}"
        role="switch" aria-checked="${panel.enabled}">${escapeHtml(this.config.getLocalizedPanelName(key, effective.name))}</button>
        <select data-font-scale="${escapeHtml(key)}" aria-label="${escapeHtml(t('settings.panels.fontScale'))}">
          ${FONT_SCALE_STEPS.map(scale => `<option value="${scale}" ${scale === parseFontScale(panel.fontScale) ? 'selected' : ''}>${fontScaleLabel(scale)}</option>`).join('')}
        </select></div>`;
    }).join(''), 'Public panel controls with escaped labels and catalog identifiers'));
    grid.querySelectorAll<HTMLElement>('[data-panel]').forEach(button => {
      button.onclick = () => {
        const panel = this.draftPanelSettings[button.dataset.panel!];
        if (!panel) return;
        panel.enabled = !panel.enabled;
        this.renderPanels();
      };
    });
    grid.querySelectorAll<HTMLSelectElement>('[data-font-scale]').forEach(select => {
      select.onchange = () => { this.draftPanelSettings[select.dataset.fontScale!]!.fontScale = parseFontScale(select.value); };
    });
  }

  private renderSources(filter = ''): void {
    const disabled = this.config.getDisabledSources();
    const names = this.config.getAllSourceNames();
    const counter = this.overlay.querySelector('.us-sources-counter');
    if (counter) counter.textContent = `${names.filter(name => !disabled.has(name)).length}/${names.length} enabled`;
    const grid = this.overlay.querySelector('.us-sources-grid');
    if (!grid) return;
    setTrustedHtml(grid, trustedHtml(names.filter(name => name.toLowerCase().includes(filter.toLowerCase())).map(name =>
      `<button class="us-source-item source-toggle-item${disabled.has(name) ? '' : ' enabled active'}" data-source="${escapeHtml(name)}"
        role="switch" aria-checked="${!disabled.has(name)}">${escapeHtml(name)}</button>`).join(''), 'Escaped public source names'));
    grid.querySelectorAll<HTMLElement>('[data-source]').forEach(button => {
      button.onclick = () => { this.config.toggleSource(button.dataset.source!); this.renderSources(filter); };
    });
  }
}
