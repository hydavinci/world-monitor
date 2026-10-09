import { getMapProvider,getMapTheme,MAP_PROVIDER_OPTIONS,MAP_THEME_OPTIONS,setMapProvider,setMapTheme,type MapProvider } from '@/config/basemap';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { getAiFlowSettings,getStreamQuality,setAiFlowSetting,setStreamQuality,STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import {
deleteImportedFramework,
getActiveFrameworkForPanel,
loadFrameworkLibrary,
renameImportedFramework,
saveImportedFramework,
type AnalysisPanelId,
} from '@/services/analysis-framework-store';

import {
FONT_SCALE_CHANGED_EVENT,
FONT_SCALE_STEPS,
fontScaleLabel,
getFontScale,
parseFontScale,
setFontScale,
type FontScaleChangedDetail,
} from '@/services/font-scale-settings';
import { getFontFamily,setFontFamily,type FontFamily } from '@/services/font-settings';
import { getGlobeVisualPreset,GLOBE_VISUAL_PRESET_OPTIONS,setGlobeVisualPreset,type GlobeVisualPreset } from '@/services/globe-render-settings';
import { changeLanguage,getCurrentLanguageTag,LANGUAGES,t } from '@/services/i18n';
import {
formatIdleStopMinutes,
getLiveMediaIdleStop,
getLiveStreamsAlwaysOn,
LIVE_MEDIA_IDLE_STOP_OPTIONS,
parseLiveMediaIdleStop,
setLiveMediaIdleStop,
setLiveStreamsAlwaysOn,
} from '@/services/live-stream-settings';
import { setTrustedHtml,trustedHtml } from '@/utils/dom-utils';
import { declareOverlay } from '@/utils/open-modal';
import { escapeHtml } from '@/utils/sanitize';
import { exportSettings,importSettings,type ImportResult } from '@/utils/settings-persistence';
import { getThemePreference,setThemePreference,type ThemePreference } from '@/utils/theme-manager';
import { getAlertSettings, updateAlertSettings } from '@/services/breaking-news-alerts';
import { getDesktopNotificationPermission, requestDesktopNotificationPermission, showDesktopNotification } from '@/services/desktop-notifications';



const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export interface PreferencesHost {
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  onSettingSaved?: () => void;
  isSignedIn?: boolean;
}

export interface PreferencesResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

function toggleRowHtml(
  id: string,
  label: string,
  desc: string,
  checked: boolean,
  disabled = false,
): string {
  // The visible text lives outside the wrapping <label>, so the checkbox
  // needs an explicit aria-labelledby/-describedby to have an accessible name.
  return `
    <div class="ai-flow-toggle-row${disabled ? ' is-disabled' : ''}">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label" id="${id}-label">${label}</div>
        <div class="ai-flow-toggle-desc" id="${id}-desc">${desc}</div>
      </div>
      <label class="ai-flow-switch${disabled ? ' is-disabled' : ''}">
        <input type="checkbox" id="${id}" aria-labelledby="${id}-label" aria-describedby="${id}-desc"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="ai-flow-slider"></span>
      </label>
    </div>
  `;
}

function renderMapThemeDropdown(container: HTMLElement, provider: MapProvider): void {
  const select = container.querySelector<HTMLSelectElement>('#us-map-theme');
  if (!select) return;
  const currentTheme = getMapTheme(provider);
  setTrustedHtml(select, trustedHtml(MAP_THEME_OPTIONS[provider]
    .map(opt => `<option value="${opt.value}"${opt.value === currentTheme ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join(''), "legacy direct innerHTML migration"));
}

function updateAiStatus(container: HTMLElement): void {
  const settings = getAiFlowSettings();
  const dot = container.querySelector('#usStatusDot');
  const text = container.querySelector('#usStatusText');
  if (!dot || !text) return;

  dot.className = 'ai-flow-status-dot';
  if (settings.browserModel) {
    dot.classList.add('browser-only');
    text.textContent = t('components.insights.aiFlowStatusBrowserOnly');
  } else {
    dot.classList.add('disabled');
    text.textContent = t('components.insights.aiFlowStatusDisabled');
  }
}

function updateNotificationControls(container: HTMLElement): void {
  const permission = getDesktopNotificationPermission();
  const settings = getAlertSettings();
  const status = container.querySelector<HTMLElement>('#us-notification-status');
  if (status) status.textContent = t(`preferences.alertNotifications.${permission}`);
  const authorize = container.querySelector<HTMLButtonElement>('#us-notification-permission');
  if (authorize) authorize.disabled = permission !== 'default';
  const test = container.querySelector<HTMLButtonElement>('#us-notification-test');
  if (test) test.disabled = permission !== 'granted' || !settings.enabled || !settings.desktopNotificationsEnabled;
}

function handlePreferenceChange(
  target: HTMLInputElement,
  container: HTMLElement,
  host: PreferencesHost,
): boolean | Promise<boolean> {
  switch (target.id) {
    case 'us-desktop-notifications':
      updateAlertSettings({ desktopNotificationsEnabled: target.checked });
      updateNotificationControls(container);
      return true;
    case 'us-stream-quality':
      setStreamQuality(target.value as StreamQuality);
      return true;
    case 'us-globe-visual-preset':
      setGlobeVisualPreset(target.value as GlobeVisualPreset);
      return true;
    case 'us-theme':
      setThemePreference(target.value as ThemePreference);
      return true;
    case 'us-font-family':
      setFontFamily(target.value as FontFamily);
      return true;
    case 'us-font-scale': {
      const scale = parseFontScale(target.value);
      if (scale === undefined) return false;
      setFontScale(scale);
      return true;
    }
    case 'us-map-provider': {
      const provider = target.value as MapProvider;
      setMapProvider(provider);
      renderMapThemeDropdown(container, provider);
      host.onMapProviderChange?.(provider);
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      return true;
    }
    case 'us-map-theme':
      setMapTheme(getMapProvider(), target.value);
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      return true;
    case 'us-live-streams-always-on':
      setLiveStreamsAlwaysOn(target.checked);
      return true;
    case 'us-live-media-idle-stop': {
      const idleStop = parseLiveMediaIdleStop(target.value);
      if (idleStop === undefined) return false;
      setLiveMediaIdleStop(idleStop);
      return true;
    }
    case 'us-language':
      {}
      return changeLanguage(target.value);
    case 'us-browser': {
      setAiFlowSetting('browserModel', target.checked);
      const warn = container.querySelector<HTMLElement>('.ai-flow-toggle-warn');
      if (warn) warn.style.display = target.checked ? 'block' : 'none';
      // Headline Memory is a child of Browser Local Model — keep its
      // toggle's enabled/disabled state in sync without re-rendering
      // the whole panel. The runtime gate (`isHeadlineMemoryEnabled`)
      // already AND-gates both flags; this just mirrors that visually.
      const hmInput = container.querySelector<HTMLInputElement>('#us-headline-memory');
      const hmRow = hmInput?.closest('.ai-flow-toggle-row');
      const hmSwitch = hmInput?.closest('.ai-flow-switch');
      if (hmInput && !host.isDesktopApp) {
        hmInput.disabled = !target.checked;
        hmRow?.classList.toggle('is-disabled', !target.checked);
        hmSwitch?.classList.toggle('is-disabled', !target.checked);
      }
      updateAiStatus(container);
      return true;
    }
    case 'us-map-flash':
      setAiFlowSetting('mapNewsFlash', target.checked);
      return true;
    case 'us-headline-memory':
      setAiFlowSetting('headlineMemory', target.checked);
      return true;
    case 'us-badge-anim':
      setAiFlowSetting('badgeAnimation', target.checked);
      return true;
    default:
      return false;
  }
}

export function renderPreferences(host: PreferencesHost): PreferencesResult {
  const settings = getAiFlowSettings();
  // Compared against LANGUAGES[].code below, which carries full tags (`zh-TW`).
  // The region-stripped accessor would mark 简体中文 selected for a Traditional reader.
  const currentLang = getCurrentLanguageTag();
  let html = '';

  // ── Display group ──
  html += `<details class="wm-pref-group" open>`;
  html += `<summary>${t('preferences.display')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  // Appearance
  const currentThemePref = getThemePreference();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-theme-label">${t('preferences.theme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.themeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-theme" aria-labelledby="us-theme-label">`;
  for (const opt of [
    { value: 'auto', label: t('preferences.themeAuto') },
    { value: 'dark', label: t('preferences.themeDark') },
    { value: 'light', label: t('preferences.themeLight') },
  ] as { value: ThemePreference; label: string }[]) {
    const selected = opt.value === currentThemePref ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Font family
  const currentFont = getFontFamily();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-font-family-label">${t('preferences.fontFamily')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.fontFamilyDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-font-family" aria-labelledby="us-font-family-label">`;
  for (const opt of [
    { value: 'mono', label: t('preferences.fontMono') },
    { value: 'system', label: t('preferences.fontSystem') },
  ] as { value: FontFamily; label: string }[]) {
    const selected = opt.value === currentFont ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Panel font scale. Fixed-geometry map chrome deliberately does not inherit
  // this value; individual panel overrides live in Settings -> Panels.
  const currentFontScale = getFontScale();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-font-scale-label">${t('preferences.fontScale', { defaultValue: 'Panel text size' })}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.fontScaleDesc', { defaultValue: 'Sets panel text globally. A panel-specific value replaces this setting.' })}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-font-scale" aria-labelledby="us-font-scale-label">`;
  for (const scale of FONT_SCALE_STEPS) {
    const selected = scale === currentFontScale ? ' selected' : '';
    html += `<option value="${scale}"${selected}>${fontScaleLabel(scale)}</option>`;
  }
  html += `</select>`;

  // Map tile provider
  const currentProvider = getMapProvider();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-map-provider-label">${t('preferences.mapProvider')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapProviderDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-provider" aria-labelledby="us-map-provider-label">`;
  for (const opt of MAP_PROVIDER_OPTIONS) {
    const selected = opt.value === currentProvider ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Map theme
  const currentMapTheme = getMapTheme(currentProvider);
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-map-theme-label">${t('preferences.mapTheme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapThemeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-theme" aria-labelledby="us-map-theme-label">`;
  for (const opt of MAP_THEME_OPTIONS[currentProvider]) {
    const selected = opt.value === currentMapTheme ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += toggleRowHtml('us-map-flash', t('components.insights.mapFlashLabel'), t('components.insights.mapFlashDesc'), settings.mapNewsFlash);

  // 3D Globe Visual Preset
  const currentPreset = getGlobeVisualPreset();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-globe-visual-preset-label">${t('preferences.globePreset')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.globePresetDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-globe-visual-preset" aria-labelledby="us-globe-visual-preset-label">`;
  for (const opt of GLOBE_VISUAL_PRESET_OPTIONS) {
    const selected = opt.value === currentPreset ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Language
  html += `<div class="ai-flow-section-label" id="us-language-label">${t('header.languageLabel')}</div>`;
  html += `<select class="unified-settings-lang-select" id="us-language" aria-labelledby="us-language-label">`;
  for (const lang of LANGUAGES) {
    const selected = lang.code === currentLang ? ' selected' : '';
    html += `<option value="${lang.code}"${selected}>${lang.flag} ${escapeHtml(lang.label)}</option>`;
  }
  html += `</select>`;
  if (currentLang === 'vi') {
    html += `<div class="ai-flow-toggle-desc">${t('components.languageSelector.mapLabelsFallbackVi')}</div>`;
  }

  html += `</div></details>`;

  const notificationPermission = getDesktopNotificationPermission();
  const alerts = getAlertSettings();
  html += `<details class="wm-pref-group">
    <summary>${t('preferences.alertNotifications.title')}</summary>
    <div class="wm-pref-group-content">
      ${toggleRowHtml('us-desktop-notifications', t('preferences.alertNotifications.desktop'),
        t('preferences.alertNotifications.description'), alerts.desktopNotificationsEnabled, notificationPermission === 'unsupported')}
      <div class="ai-flow-toggle-desc" id="us-notification-status" role="status" aria-live="polite"></div>
      <div class="us-data-mgmt">
        <button type="button" class="btn btn-secondary" id="us-notification-permission">${t('preferences.alertNotifications.authorize')}</button>
        <button type="button" class="btn btn-secondary" id="us-notification-test">${t('preferences.alertNotifications.test')}</button>
      </div>
    </div>
  </details>`;

  // ── Intelligence group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.intelligence')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  if (!host.isDesktopApp) {
    html += toggleRowHtml('us-browser', t('components.insights.aiFlowBrowserLabel'), t('components.insights.aiFlowBrowserDesc'), settings.browserModel);
    html += `<div class="ai-flow-toggle-warn" style="display:${settings.browserModel ? 'block' : 'none'}">${t('components.insights.aiFlowBrowserWarn')}</div>`;
    html += `
      <div class="ai-flow-cta">
        <div class="ai-flow-cta-title">${t('components.insights.aiFlowOllamaCta')}</div>
        <div class="ai-flow-cta-desc">${t('components.insights.aiFlowOllamaCtaDesc')}</div>
        <a href="${DESKTOP_RELEASES_URL}" target="_blank" rel="noopener noreferrer" class="ai-flow-cta-link">${t('components.insights.aiFlowDownloadDesktop')}</a>
      </div>
    `;
  }

  // Headline Memory requires Browser Local Model (it loads an embeddings
  // model in the ML worker). Disable the toggle when the parent is off so
  // the user sees the dependency rather than wondering why their Headline
  // Memory toggle "did nothing."
  const headlineDisabled = !host.isDesktopApp && !settings.browserModel;
  html += toggleRowHtml(
    'us-headline-memory',
    t('components.insights.headlineMemoryLabel'),
    t('components.insights.headlineMemoryDesc'),
    settings.headlineMemory,
    headlineDisabled,
  );

  html += `</div></details>`;

  // ── Analysis Frameworks group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('components.insights.analysisFrameworksLabel')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  // Per-panel active framework display
  const panelIds: Array<{ id: AnalysisPanelId; label: string }> = [
    { id: 'insights', label: 'Insights' },
    { id: 'country-brief', label: 'Country Brief' },
    { id: 'daily-market-brief', label: 'Market Brief' },
    { id: 'deduction', label: 'Deduction' },
  ];
  html += `<div class="ai-flow-section-label">${t('components.insights.analysisFrameworksActivePerPanel')}</div>`;
  html += `<div class="fw-panel-status-list" id="fwPanelStatusList">`;
  for (const { id, label } of panelIds) {
    const active = getActiveFrameworkForPanel(id);
    html += `<div class="fw-panel-status-row">
      <span class="fw-panel-status-name">${escapeHtml(label)}</span>
      <span class="fw-panel-status-val">${active ? escapeHtml(active.name) : t('components.insights.analysisFrameworksDefaultNeutral')}</span>
    </div>`;
  }
  html += `</div>`;

  // Skill library list
  html += `<div class="ai-flow-section-label">${t('components.insights.analysisFrameworksSkillLibrary')}</div>`;
  html += `<div class="fw-library-list" id="fwLibraryList">`;
  html += renderFrameworkLibraryHtml();
  html += `</div>`;

  // Import button
  html += `<div class="fw-import-row">
    <button type="button" class="btn btn-secondary fw-import-btn" id="fwImportBtn">${t('components.insights.analysisFrameworksImportBtn')}</button>
  </div>`;

  // Import modal (hidden by default)
  html += `<div class="fw-import-modal-backdrop" id="fwImportModalBackdrop" style="display:none">
    <div class="fw-import-modal" role="dialog" aria-modal="true" aria-label="Import framework">
      <div class="fw-import-modal-header">
        <span class="fw-import-modal-title">${t('components.insights.analysisFrameworksImportTitle')}</span>
        <button type="button" class="fw-import-modal-close" id="fwImportModalClose" aria-label="Close">&times;</button>
      </div>
      <div class="fw-import-tabs">
        <button type="button" class="fw-import-tab active" data-fw-tab="agentskills" id="fwTabAgentskills">${t('components.insights.analysisFrameworksFromAgentskills')}</button>
        <button type="button" class="fw-import-tab" data-fw-tab="json" id="fwTabJson">${t('components.insights.analysisFrameworksPasteJson')}</button>
      </div>
      <div class="fw-import-tab-panel active" id="fwTabPanelAgentskills">
        <div class="fw-import-field">
          <label class="fw-import-label">agentskills.io URL or ID</label>
          <input type="text" class="fw-import-input" id="fwAgentskillsUrl" placeholder="https://agentskills.io/skills/..." />
        </div>
        <button type="button" class="btn btn-secondary" id="fwFetchBtn">Fetch</button>
        <div class="fw-import-preview" id="fwAgentskillsPreview" style="display:none">
          <div class="fw-import-preview-name" id="fwPreviewName"></div>
          <div class="fw-import-preview-desc" id="fwPreviewDesc"></div>
          <button type="button" class="btn btn-primary fw-save-btn" id="fwAgentskillsSaveBtn">${t('components.insights.analysisFrameworksSaveToLibrary')}</button>
        </div>
        <div class="fw-import-error" id="fwAgentskillsError" style="display:none"></div>
      </div>
      <div class="fw-import-tab-panel" id="fwTabPanelJson">
        <div class="fw-import-field">
          <label class="fw-import-label">${t('components.insights.analysisFrameworksPasteJson')}</label>
          <textarea class="fw-import-textarea" id="fwJsonInput" rows="6" placeholder='{ "name": "...", "instructions": "..." }'></textarea>
        </div>
        <div class="fw-import-error" id="fwJsonError" style="display:none"></div>
        <button type="button" class="btn btn-primary fw-save-btn" id="fwJsonSaveBtn">${t('components.insights.analysisFrameworksSaveToLibrary')}</button>
      </div>
    </div>
  </div>`;

  html += `</div></details>`;

  // ── Media group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.media')}</summary>`;
  html += `<div class="wm-pref-group-content">`;

  const currentQuality = getStreamQuality();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-stream-quality-label">${t('components.insights.streamQualityLabel')}</div>
      <div class="ai-flow-toggle-desc">${t('components.insights.streamQualityDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-stream-quality" aria-labelledby="us-stream-quality-label">`;
  for (const opt of STREAM_QUALITY_OPTIONS) {
    const selected = opt.value === currentQuality ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  html += toggleRowHtml(
    'us-live-streams-always-on',
    t('components.insights.streamAlwaysOnLabel'),
    t('components.insights.streamAlwaysOnDesc'),
    getLiveStreamsAlwaysOn(),
  );

  const currentIdleStop = getLiveMediaIdleStop();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label" id="us-live-media-idle-stop-label">${t('components.insights.streamIdleStopLabel')}</div>
      <div class="ai-flow-toggle-desc">${t('components.insights.streamIdleStopDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-live-media-idle-stop" aria-labelledby="us-live-media-idle-stop-label">`;
  for (const option of LIVE_MEDIA_IDLE_STOP_OPTIONS) {
    const label = option === 'never'
      ? t('components.insights.streamIdleStopNever')
      : formatIdleStopMinutes(option, getCurrentLanguageTag());
    const selected = option === currentIdleStop ? ' selected' : '';
    html += `<option value="${option}"${selected}>${escapeHtml(label)}</option>`;
  }
  html += `</select>`;

  html += `</div></details>`;

  // ── Panels group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.panels')}</summary>`;
  html += `<div class="wm-pref-group-content">`;
  html += toggleRowHtml('us-badge-anim', t('components.insights.badgeAnimLabel'), t('components.insights.badgeAnimDesc'), settings.badgeAnimation);
  html += `</div></details>`;

  // ── Data & Community group ──
  html += `<details class="wm-pref-group">`;
  html += `<summary>${t('preferences.dataAndCommunity')}</summary>`;
  html += `<div class="wm-pref-group-content">`;
  html += `
    <div class="us-data-mgmt">
      <button type="button" class="btn btn-secondary" id="usExportBtn">${t('components.settings.exportSettings')}</button>
      <button type="button" class="btn btn-secondary" id="usImportBtn">${t('components.settings.importSettings')}</button>
      <input type="file" id="usImportInput" accept=".json" class="us-hidden-input" />
    </div>
    <div class="us-data-mgmt-toast" id="usDataMgmtToast"></div>
  `;
  html += `</div></details>`;

  // AI status footer (web-only)
  if (!host.isDesktopApp) {
    html += `<div class="ai-flow-popup-footer"><span class="ai-flow-status-dot" id="usStatusDot"></span><span class="ai-flow-status-text" id="usStatusText"></span></div>`;
  }

  return {
    html,
    attach(container: HTMLElement): () => void {
      // The import modal is authored in the template above, so it declares
      // after mount. Pasted JSON and a URL input make it blocking.
      const importModal = container.querySelector<HTMLElement>('.fw-import-modal');
      if (importModal) declareOverlay(importModal, { reload: 'blocking' });

      const ac = new AbortController();
      const { signal } = ac;
      updateNotificationControls(container);
      window.addEventListener('focus', () => updateNotificationControls(container), { signal });

      window.addEventListener(FONT_SCALE_CHANGED_EVENT, (event) => {
        const select = container.querySelector<HTMLSelectElement>('#us-font-scale');
        const scale = (event as CustomEvent<FontScaleChangedDetail>).detail?.scale;
        if (select && scale !== undefined) select.value = String(scale);
      }, { signal });

      container.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;

        if (target.id === 'usImportInput') {
          const file = target.files?.[0];
          if (!file) return;
          importSettings(file).then((result: ImportResult) => {
            showToast(container, t('components.settings.importSuccess', { count: String(result.keysImported) }), true);
          }).catch(() => {
            showToast(container, t('components.settings.importFailed'), false);
          });
          target.value = '';
          return;
        }

        const saveResult = handlePreferenceChange(target, container, host);
        if (typeof saveResult === 'boolean') {
          if (saveResult) host.onSettingSaved?.();
          return;
        }
        void saveResult.then((saved) => {
          if (saved) host.onSettingSaved?.();
        }).catch(() => undefined);
      }, { signal });

      container.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const authorize = target.closest<HTMLButtonElement>('#us-notification-permission');
        if (authorize && !authorize.disabled) {
          authorize.disabled = true;
          void requestDesktopNotificationPermission().then(() => {
            if (!signal.aborted) updateNotificationControls(container);
          }).catch(error => {
            console.error('[desktop-notifications] Permission request failed:', error);
            if (signal.aborted) return;
            updateNotificationControls(container);
            const status = container.querySelector<HTMLElement>('#us-notification-status');
            if (status) status.textContent = t('preferences.alertNotifications.permissionFailed');
          });
          return;
        }
        const test = target.closest<HTMLButtonElement>('#us-notification-test');
        if (test && !test.disabled) {
          const alerts = getAlertSettings();
          if (!alerts.enabled || !alerts.desktopNotificationsEnabled) {
            updateNotificationControls(container);
            return;
          }
          showDesktopNotification(
            t('preferences.alertNotifications.testTitle'),
            t('preferences.alertNotifications.testBody'),
            'wm-breaking-test',
            () => {},
          );
          return;
        }
        if (target.closest('#usExportBtn')) {
          try {
            exportSettings();
            showToast(container, t('components.settings.exportSuccess'), true);
          } catch {
            showToast(container, t('components.settings.exportFailed'), false);
          }
          return;
        }
        if (target.closest('#usImportBtn')) {
          container.querySelector<HTMLInputElement>('#usImportInput')?.click();
          return;
        }

        // ── Framework settings handlers ──

        if (target.closest('#fwImportBtn')) {
          const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
          if (backdrop) backdrop.style.display = 'flex';
          return;
        }

        if (target.closest('#fwImportModalClose') || target.id === 'fwImportModalBackdrop') {
          const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
          if (backdrop) backdrop.style.display = 'none';
          return;
        }

        const tab = target.closest<HTMLElement>('[data-fw-tab]');
        if (tab?.dataset.fwTab) {
          const tabId = tab.dataset.fwTab;
          container.querySelectorAll('.fw-import-tab').forEach(el => el.classList.toggle('active', (el as HTMLElement).dataset.fwTab === tabId));
          container.querySelectorAll('.fw-import-tab-panel').forEach(el => {
            const panelEl = el as HTMLElement;
            panelEl.classList.toggle('active', panelEl.id === `fwTabPanel${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
          });
          return;
        }

        if (target.closest('#fwFetchBtn')) {
          const urlInput = container.querySelector<HTMLInputElement>('#fwAgentskillsUrl');
          const errEl = container.querySelector<HTMLElement>('#fwAgentskillsError');
          const preview = container.querySelector<HTMLElement>('#fwAgentskillsPreview');
          if (!urlInput) return;
          hideImportError(errEl);
          if (preview) preview.style.display = 'none';
          const urlVal = urlInput.value.trim();
          let skillHostname = '';
          try { skillHostname = new URL(urlVal).hostname; } catch { /* rejected below */ }
          if (!['agentskills.io', 'www.agentskills.io', 'api.agentskills.io'].includes(skillHostname)) {
            showImportError(errEl, 'Only agentskills.io URLs are supported.');
            return;
          }
          const fetchBtn = container.querySelector<HTMLButtonElement>('#fwFetchBtn');
          if (fetchBtn) fetchBtn.disabled = true;
          fetch('/api/skills/fetch-agentskills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: urlVal }),
            signal,
          }).then(async (res) => {
            if (res.status === 429) throw new Error('rate-limit');
            if (!res.ok) throw new Error('network');
            return res.json() as Promise<{ name?: string; description?: string; instructions?: string }>;
          }).then((data) => {
            if (!data.instructions) {
              showImportError(errEl, 'This skill has no instructions — it may use tools only (not supported).');
              return;
            }
            const nameEl = container.querySelector<HTMLElement>('#fwPreviewName');
            const descEl = container.querySelector<HTMLElement>('#fwPreviewDesc');
            if (nameEl) nameEl.textContent = data.name ?? 'Unnamed skill';
            if (descEl) descEl.textContent = data.instructions.slice(0, 200) + (data.instructions.length > 200 ? '…' : '');
            if (preview) {
              preview.style.display = 'block';
              (preview as HTMLElement & { _fwData?: { name: string; description: string; instructions: string } })._fwData = {
                name: data.name ?? 'Unnamed skill',
                description: data.description ?? '',
                instructions: data.instructions,
              };
            }
          }).catch((err: Error) => {
            if (err.name === 'AbortError') return;
            if (err.message === 'rate-limit') {
              showImportError(errEl, 'Too many import requests. Try again in a minute.');
            } else {
              showImportError(errEl, 'Could not reach agentskills.io. Check your connection.');
            }
          }).finally(() => {
            if (fetchBtn) fetchBtn.disabled = false;
          });
          return;
        }

        if (target.closest('#fwAgentskillsSaveBtn')) {
          const preview = container.querySelector<HTMLElement>('#fwAgentskillsPreview');
          const errEl = container.querySelector<HTMLElement>('#fwAgentskillsError');
          const fwData = (preview as HTMLElement & { _fwData?: { name: string; description: string; instructions: string } } | null)?._fwData;
          if (!fwData) return;
          try {
            saveImportedFramework({ id: crypto.randomUUID(), name: fwData.name, description: fwData.description, systemPromptAppend: fwData.instructions });
            refreshFrameworkLibrary(container);
            const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
            if (backdrop) backdrop.style.display = 'none';
          } catch (err) {
            showImportError(errEl, (err as Error).message);
          }
          return;
        }

        if (target.closest('#fwJsonSaveBtn')) {
          const textarea = container.querySelector<HTMLTextAreaElement>('#fwJsonInput');
          const errEl = container.querySelector<HTMLElement>('#fwJsonError');
          if (!textarea) return;
          hideImportError(errEl);
          let parsed: { name?: string; description?: string; instructions?: string };
          try {
            parsed = JSON.parse(textarea.value) as typeof parsed;
          } catch {
            showImportError(errEl, 'Could not parse skill definition. Paste valid JSON.');
            return;
          }
          if (!parsed.instructions) {
            showImportError(errEl, 'This skill has no instructions — it may use tools only (not supported).');
            return;
          }
          try {
            saveImportedFramework({
              id: crypto.randomUUID(),
              name: parsed.name ?? 'Imported skill',
              description: parsed.description ?? '',
              systemPromptAppend: parsed.instructions,
            });
            textarea.value = '';
            refreshFrameworkLibrary(container);
            const backdrop = container.querySelector<HTMLElement>('#fwImportModalBackdrop');
            if (backdrop) backdrop.style.display = 'none';
          } catch (err) {
            showImportError(errEl, (err as Error).message);
          }
          return;
        }

        const deleteBtn = target.closest<HTMLElement>('.fw-delete-btn');
        if (deleteBtn?.dataset.fwId) {
          deleteImportedFramework(deleteBtn.dataset.fwId);
          refreshFrameworkLibrary(container);
          return;
        }

        const renameBtn = target.closest<HTMLElement>('.fw-rename-btn');
        if (renameBtn?.dataset.fwId) {
          const fwId = renameBtn.dataset.fwId;
          const current = renameBtn.closest('.fw-library-item')?.querySelector('.fw-library-item-name');
          const currentName = current?.childNodes[0]?.textContent?.trim() ?? '';
          const newName = prompt('Rename framework:', currentName);
          if (newName && newName.trim() && newName.trim() !== currentName) {
            renameImportedFramework(fwId, newName.trim());
            refreshFrameworkLibrary(container);
          }
          return;
        }
      }, { signal });

      if (!host.isDesktopApp) updateAiStatus(container);

      return () => ac.abort();
    },
  };
}

function renderFrameworkLibraryHtml(): string {
  const frameworks = loadFrameworkLibrary();
  if (frameworks.length === 0) return '<div class="fw-library-empty">No frameworks in library.</div>';
  return frameworks.map(fw => `
    <div class="fw-library-item" data-fw-id="${escapeHtml(fw.id)}">
      <div class="fw-library-item-info">
        <div class="fw-library-item-name">${escapeHtml(fw.name)}${fw.isBuiltIn ? ' <span class="fw-builtin-badge">built-in</span>' : ''}</div>
        <div class="fw-library-item-desc">${escapeHtml(fw.description)}</div>
      </div>
      ${!fw.isBuiltIn ? `
        <div class="fw-library-item-actions">
          <button type="button" class="fw-lib-btn fw-rename-btn" data-fw-id="${escapeHtml(fw.id)}">Rename</button>
          <button type="button" class="fw-lib-btn fw-lib-btn-danger fw-delete-btn" data-fw-id="${escapeHtml(fw.id)}">Delete</button>
        </div>
      ` : ''}
    </div>
  `).join('');
}

function refreshFrameworkLibrary(container: HTMLElement): void {
  const list = container.querySelector('#fwLibraryList');
  if (list) setTrustedHtml(list, trustedHtml(renderFrameworkLibraryHtml(), "legacy direct innerHTML migration"));
}

function showImportError(el: HTMLElement | null, msg: string): void {
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideImportError(el: HTMLElement | null): void {
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

function showToast(container: HTMLElement, msg: string, success: boolean): void {
  const toast = container.querySelector('#usDataMgmtToast');
  if (!toast) return;
  toast.className = `us-data-mgmt-toast ${success ? 'ok' : 'error'}`;
  setTrustedHtml(toast, trustedHtml(success
    ? `${escapeHtml(msg)} <a href="#" class="us-toast-reload">${t('components.settings.reloadNow')}</a>`
    : escapeHtml(msg), "legacy direct innerHTML migration"));
  toast.querySelector('.us-toast-reload')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.reload();
  });
}
