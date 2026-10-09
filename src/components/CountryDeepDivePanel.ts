import {
composeProvenanceSummary,
declaredSourceTier,
describePropagandaBadge,
getProvenanceFacts,
getSourcePropagandaRisk,
getSourceTier,
getSourceTierBadgeTitle,
getSourceType,
PERSPECTIVE_LABEL_CAVEAT,
} from '@/config/feeds';
import { PORTS } from '@/config/ports';
import type { ListFuelShortagesResponse,ListPipelinesResponse,ListStorageFacilitiesResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

import { CountrySectionError } from '@/services/country-brief-error';
import type { CountryBriefSource } from '@/services/country-brief-source';
import { getCountryCentroid,ME_STRIKE_BOUNDS } from '@/services/country-geometry';
import type { CountryScore } from '@/services/country-instability';
import { t } from '@/services/i18n';
import type { PredictionMarket } from '@/services/prediction';
import { getCountryInfrastructure,haversineDistanceKm } from '@/services/related-assets';
import type { AssetType,CountrySignalCounts,NewsItem,RelatedAsset } from '@/types';
import { getCSSColor,isMobileDevice,showToast } from '@/utils';
import { collectBriefSources,renderBriefSourcesFooter,type BriefSource } from '@/utils/brief-sources';
import { assessCorroboration,corroborationFlag,evidenceFromCluster,publisherRoster } from '@/utils/corroboration-flag';
import { toFlagEmoji } from '@/utils/country-flag';
import { attemptWebCountryDownload,type CountryTextDownload } from '@/utils/country-text-download';
import { setTrustedHtml,trustedHtml } from '@/utils/dom-utils';
import { renderFollowButton } from '@/utils/follow-button';
import { formatIntelBrief,renderBriefEvidenceFooter,type IntelBriefEvidence } from '@/utils/format-intel-brief';
import { decodeHtmlEntities } from '@/utils/html-entities';
import { overlayHistory,type OverlayCloseOrigin } from '@/utils/overlay-history';
import { sanitizeUrl } from '@/utils/sanitize';
import { CHINA_DECISION_SIGNAL_GROUP_IDS } from '../../shared/china-decision-signals';
import type { BriefTopic } from '../../shared/country-brief-sections';
import { briefSectionState,CountryBriefPresentation,summarizeCountryBrief,type BriefSection,type BriefSectionId } from './country-brief-presentation';
import type {
ChinaCountrySummaryData,
ChinaCountrySummaryGroup,
ChinaCountrySummaryGroupId,
CountryBriefPanel,
CountryDeepDiveEconomicIndicator,
CountryDeepDiveMilitarySummary,
CountryDeepDiveSignalDetails,
CountryDeepDiveSignalItem,
CountryEnergyProfileData,
CountryFactsData,
CountryIntelData,
CountryPortActivityData,
StockIndexData,
} from './CountryBriefPanel';
import { ciiBandForLevel } from './CountryDeepDivePanel-cii';
import { dedupeHeadlines } from './CountryDeepDivePanel-news-utils';
import type { MapContainer } from './MapContainer';
import { describePublisherRoster,renderPublisherRosterElement } from './news/publisher-roster';



type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
type TrendDirection = 'up' | 'down' | 'flat';

const INFRA_TYPES: AssetType[] = ['pipeline', 'cable', 'datacenter', 'base', 'nuclear'];

const INFRA_ICONS: Record<AssetType, string> = {
  pipeline: '🛢️',
  cable: '🌐',
  datacenter: '🖥️',
  base: '🛡️',
  nuclear: '☢️',
};

const SEVERITY_ORDER: Record<ThreatLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

// Clamp long disruption shortDescriptions when rendered in the compact
// CountryDeepDive Atlas row. Some registry entries (OFAC designations,
// multi-clause sanctions summaries) run 100–200 chars; without a clamp
// they overflow the row. 80 chars is a balance between scannability and
// information density; full detail stays accessible by clicking through
// to the asset drawer.
const DISRUPTION_LABEL_MAX_LEN = 80;
function truncateDisruptionLabel(eventType: string, shortDescription: string): string {
  const base = `${eventType} — ${shortDescription}`;
  if (base.length <= DISRUPTION_LABEL_MAX_LEN) return base;
  return base.slice(0, DISRUPTION_LABEL_MAX_LEN - 1) + '…';
}

export class CountryDeepDivePanel implements CountryBriefPanel {
  private panel: HTMLElement;
  private content: HTMLElement;
  private closeButton: HTMLButtonElement;
  private outputClose: (() => void) | null = null;
  private currentCode: string | null = null;
  private currentName: string | null = null;
  private currentSignals: CountrySignalCounts | null = null;
  private currentSignalDetails: CountryDeepDiveSignalDetails | null = null;
  private currentBriefIsFallback = false;
  private historyRegistered = false;
  private isMaximizedState = false;
  private onCloseCallback?: () => void;
  private onStateChangeCallback?: (state: { visible: boolean; maximized: boolean }) => void;
  private map: MapContainer | null;
  private abortController: AbortController = new AbortController();
  private lastFocusedElement: HTMLElement | null = null;
  private economicIndicators: CountryDeepDiveEconomicIndicator[] = [];
  private infrastructureByType = new Map<AssetType, RelatedAsset[]>();
  private maximizeButton: HTMLButtonElement | null = null;
  private currentHeadlineCount = 0;
  private presentation: CountryBriefPresentation | null = null;
  private sections: BriefSection[] = [];
  private atlasRevision = 0;
  private hostedAtlasBody: HTMLElement | null = null;
  private hostedAtlas: { code: string; signal: AbortSignal; pipelines?: ListPipelinesResponse; facilities?: ListStorageFacilitiesResponse; shortages?: ListFuelShortagesResponse } | null = null;
  private atlasSelection: { type: 'pipeline' | 'storage' | 'shortage'; id: string } | null = null;
  private signalsBody: HTMLElement | null = null;
  private signalCoverageNotes: readonly string[] = [];
  private signalBreakdownBody: HTMLElement | null = null;
  private signalRecentBody: HTMLElement | null = null;
  private newsBody: HTMLElement | null = null;
  private militaryBody: HTMLElement | null = null;
  private currentMilitarySummary: CountryDeepDiveMilitarySummary | null = null;
  private infrastructureBody: HTMLElement | null = null;
  private economicBody: HTMLElement | null = null;
  private chinaSummaryBody: HTMLElement | null = null;
  private housingBody: HTMLElement | null = null;
  private marketsBody: HTMLElement | null = null;
  private briefBody: HTMLElement | null = null;
  private timelineBody: HTMLElement | null = null;
  private scoreCard: HTMLElement | null = null;
  private factsBody: HTMLElement | null = null;
  private energyBody: HTMLElement | null = null;
  private maritimeBody: HTMLElement | null = null;
  // Holds the teardown returned by the FollowButton's `attach()` mounted
  // in the title row. The skeleton is rebuilt every `show()` call (via
  // `resetPanelContent` → `renderSkeleton`), and the panel itself is
  // long-lived (singleton on `document.body`), so this teardown must
  // fire BEFORE the skeleton is wiped and on `hide()`.
  private followButtonTeardown: (() => void) | null = null;
  // Sibling teardown for the U8 "Notify me about this country" sub-action
  // mounted alongside the FollowButton. Same lifecycle constraints.

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!this.panel.classList.contains('active')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.outputClose) {
        return;
      }
      if (this.isMaximizedState) {
        this.minimize();
      } else {
        this.hide();
      }
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    const current = document.activeElement as HTMLElement | null;
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  constructor(map: MapContainer | null = null, private readonly source?: CountryBriefSource, _downloadText: CountryTextDownload = attemptWebCountryDownload) {
    this.map = map;
    this.panel = this.getOrCreatePanel();

    const content = this.panel.querySelector<HTMLElement>('#deep-dive-content');
    const closeButton = this.panel.querySelector<HTMLButtonElement>('#deep-dive-close');
    if (!content || !closeButton) {
      throw new Error('Country deep-dive panel structure is invalid');
    }
    this.content = content;
    this.closeButton = closeButton;

    this.closeButton.addEventListener('click', () => this.hide());

    this.panel.addEventListener('click', (e) => {
      if (this.isMaximizedState && (e.target === this.panel || e.target === this.content.parentElement)) {
        this.minimize();
      }
    });
  }

  public selectTopic(topic: BriefTopic): void {
    this.presentation?.selectTopic(topic);
  }

  public setSectionFailure(id: BriefSectionId, state: 'locked' | 'unavailable', reason: string): void {
    if (id === 'military') {
      if (state === 'locked')
      return;
    }
    const section = this.sections.find(section => section.id === id);
    if (!section) return;
    if (state === 'locked') {
      this.setSectionCoverage(id, []);
      if (id === 'trade') { }
    }
    const { card } = section;
    const body = id === 'energy' && this.hostedAtlasBody ? this.energyBody! : section.body;
    const notice = this.makeEmpty(reason);
    notice.dataset.briefState = state;
    const previous = briefSectionState({ id, title: '', card, body });
    if (state === 'unavailable' && previous === 'ready') {
      notice.textContent = `${reason} Previously loaded observations remain visible.`;
      body.querySelector('.cdp-refresh-failure')?.remove();
      notice.classList.add('cdp-refresh-failure');
      body.append(notice);
    } else body.replaceChildren(notice);
  }

  public setMap(map: MapContainer | null): void {
    this.map = map;
  }

  public setSectionCoverage(id: BriefSectionId, missing: string[]): void {
    const section = this.sections.find(section => section.id === id);
    if (!section) return;
    section.card.querySelector('.cdp-section-coverage')?.remove();
    section.card.dataset.briefCoverage = missing.length ? 'partial' : 'complete';
    if (!missing.length) return;
    const labels: Record<string, string> = {
      imfMacro: 'inflation and fiscal indicators', imfGrowth: 'growth and GDP',
      imfLabor: 'employment', imfExternal: 'external trade',
      bisDsr: 'household debt service', bisPropertyResidential: 'residential property',
      bisPropertyCommercial: 'commercial property',
    };
    const notice = this.el('div', 'cdp-empty cdp-section-coverage', `Partial coverage. Unavailable data: ${missing.map(key => labels[key] ?? 'additional measurements').join(', ')}. Available measurements remain visible.`);
    notice.setAttribute('role', 'status');
    section.card.append(notice);
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public showLoading(): void {
    this.currentCode = '__loading__';
    this.currentName = null;
    this.renderLoading();
    this.open();
  }

  public showGeoError(onRetry: () => void): void {
    this.currentCode = '__error__';
    this.currentName = null;
    this.resetPanelContent();

    const wrapper = this.el('div', 'cdp-geo-error');
    wrapper.append(
      this.el('div', 'cdp-geo-error-icon', '\u26A0\uFE0F'),
      this.el('div', 'cdp-geo-error-msg', t('countryBrief.geocodeFailed')),
    );

    const actions = this.el('div', 'cdp-geo-error-actions');

    const retryBtn = this.el('button', 'cdp-geo-error-retry', t('countryBrief.retryBtn')) as HTMLButtonElement;
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => onRetry(), { once: true });

    const closeBtn = this.el('button', 'cdp-geo-error-close', t('countryBrief.closeBtn')) as HTMLButtonElement;
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => this.hide(), { once: true });

    actions.append(retryBtn, closeBtn);
    wrapper.append(actions);
    this.content.append(wrapper);
  }

  public show(country: string, code: string, score: CountryScore | null, signals: CountrySignalCounts | null): void {
    this.signalCoverageNotes = [];
    this.abortController.abort();
    this.abortController = new AbortController();
    this.currentCode = code;
    this.currentName = country;
    this.currentSignals = signals;
    this.currentBriefIsFallback = false;
    this.currentHeadlineCount = 0;
    this.economicIndicators = [];
    this.infrastructureByType.clear();
    this.renderSkeleton(country, code, score, signals);
    if (this.source?.mode === 'host') this.renderAtlasExposure(true);
    this.content.scrollTop = 0;
    this.open();
  }

  public hide(origin: OverlayCloseOrigin = 'control'): void {
    this.presentation?.destroy();
    if (origin === 'control' && this.historyRegistered) overlayHistory.close('deep-dive');
    this.historyRegistered = false;
    this.tearDownFollowButton();
    if (this.isMaximizedState) {
      this.isMaximizedState = false;
      this.panel.classList.remove('maximized');
      if (this.maximizeButton) this.maximizeButton.textContent = '\u26F6';
    }
    this.abortController.abort();
    this.close();
    this.currentCode = null;
    this.currentName = null;
    this.currentSignals = null;
    this.signalCoverageNotes = [];
    this.onCloseCallback?.();
    this.onStateChangeCallback?.({ visible: false, maximized: false });
  }

  public onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  public onStateChange(cb: (state: { visible: boolean; maximized: boolean }) => void): void {
    this.onStateChangeCallback = cb;
  }

  public maximize(): void {
    if (this.isMaximizedState) return;
    this.isMaximizedState = true;
    this.panel.classList.add('maximized');
    if (this.maximizeButton) this.maximizeButton.textContent = '\u229F';
    this.onStateChangeCallback?.({ visible: true, maximized: true });
  }

  public minimize(): void {
    if (!this.isMaximizedState) return;
    this.isMaximizedState = false;
    this.panel.classList.remove('maximized');
    if (this.maximizeButton) this.maximizeButton.textContent = '\u26F6';
    this.onStateChangeCallback?.({ visible: true, maximized: false });
  }

  public getIsMaximized(): boolean {
    return this.isMaximizedState;
  }

  public isVisible(): boolean {
    return this.panel.classList.contains('active');
  }

  public getCode(): string | null {
    return this.currentCode;
  }

  public getName(): string | null {
    return this.currentName;
  }

  public getTimelineMount(): HTMLElement | null {
    return this.timelineBody;
  }

  public getSignalCounts(): CountrySignalCounts | null {
    return this.currentSignals ? { ...this.currentSignals } : null;
  }

  public updateSignals(signals: CountrySignalCounts, notes: readonly string[] = []): void {
    this.currentSignals = signals;
    this.signalCoverageNotes = notes.slice(0, 12).map(note => note.slice(0, 1600));
    this.renderInitialSignals(signals);
    const liveValues = Object.entries(signals).filter(([key]) => key !== 'isTier1').map(([, value]) => value);
    const partial = liveValues.some(value => value === null);
    if (partial) {
      const notice = this.el('p', 'cdp-economic-source', 'Signal coverage is partial. Unavailable inputs are not evidence of zero activity.');
      if (liveValues.every(value => value === null)) notice.dataset.briefState = 'unavailable';
      this.signalsBody?.prepend(notice);
    }
    for (const note of this.signalCoverageNotes) this.signalsBody?.append(this.el('p', 'cdp-economic-source', note));
    const section = this.sections.find(section => section.id === 'signals');
    if (section) section.card.dataset.briefCoverage = partial ? 'partial' : 'complete';
  }

  public updateSignalDetails(details: CountryDeepDiveSignalDetails): void {
    this.currentSignalDetails = details;
    if (!this.signalBreakdownBody || !this.signalRecentBody) return;
    this.renderSignalBreakdown(details);
    this.renderRecentSignals(details.recentHigh);
  }

  public updateNews(headlines: NewsItem[]): void {
    if (!this.newsBody) return;
    this.newsBody.replaceChildren();

    const compare = (a: NewsItem, b: NewsItem) => {
      const sa = SEVERITY_ORDER[this.toThreatLevel(a.threat?.level)];
      const sb = SEVERITY_ORDER[this.toThreatLevel(b.threat?.level)];
      if (sb !== sa) return sb - sa;
      return this.toTimestamp(b.pubDate) - this.toTimestamp(a.pubDate);
    };

    const sorted = [...headlines].sort(compare);

    const deduped = dedupeHeadlines(sorted, (it) => it.tier ?? getSourceTier(it.source))
      .sort((a, b) => compare(a.item, b.item));

    this.currentHeadlineCount = deduped.length;

    if (deduped.length === 0) {
      this.newsBody.append(this.makeEmpty(t('countryBrief.noNews')));
      return;
    }

    for (let i = 0; i < deduped.length; i++) {
      const { item, items } = deduped[i]!;
      const evidence = evidenceFromCluster({ allItems: items });
      const corroboration = assessCorroboration(evidence);
      const row = this.el('a', 'cdp-news-item');
      row.id = `cdp-news-${i + 1}`;
      const href = sanitizeUrl(item.link);
      if (href) {
        row.setAttribute('href', href);
        row.setAttribute('target', '_blank');
        row.setAttribute('rel', 'noopener');
      } else {
        row.removeAttribute('href');
      }

      const top = this.el('div', 'cdp-news-top');
      const tier = declaredSourceTier(item.source);
      const sourceType = getSourceType(item.source);
      if (tier !== null) {
        const tierBadge = this.badge(`T${tier} SRC`, `cdp-tier-badge tier-${tier}`);
        tierBadge.setAttribute(
          'title',
          `${getSourceTierBadgeTitle(sourceType)}. Source tier ${tier}; independent of article severity.`,
        );
        top.append(tierBadge);
      }

      const severity = this.toThreatLevel(item.threat?.level);
      const levelKey = severity === 'info' ? 'low' : severity === 'medium' ? 'moderate' : severity;
      const severityLabel = t(`countryBrief.levels.${levelKey}`);
      const sevBadge = this.badge(severityLabel.toUpperCase(), `cdp-severity-badge sev-${severity}`);
      sevBadge.setAttribute('title', 'Article severity: how serious the event is. Independent of source tier.');
      top.append(sevBadge);

      const risk = getSourcePropagandaRisk(item.source);
      const riskDescription = describePropagandaBadge(risk, sourceType);
      if (riskDescription) {
        const riskBadge = this.badge(
          riskDescription.label,
          `cdp-state-badge propaganda-badge ${riskDescription.risk}`,
        );
        riskBadge.setAttribute('title', riskDescription.title);
        top.append(riskBadge);
      }
      const factTitle = `${composeProvenanceSummary(risk, sourceType)} ${PERSPECTIVE_LABEL_CAVEAT}`;
      for (const fact of getProvenanceFacts(risk, sourceType)) {
        const factBadge = this.badge(fact.label, `cdp-state-badge provenance-fact ${fact.kind}`);
        factBadge.setAttribute('title', factTitle);
        top.append(factBadge);
      }

      const title = this.el('div', 'cdp-news-title', decodeHtmlEntities(item.title));
      const meta = this.el('div', 'cdp-news-meta', `${item.source} • ${this.formatRelativeTime(item.pubDate)}`);
      const flag = corroborationFlag(corroboration);
      if (flag) {
        const pill = this.el('span', 'corroboration-flag', flag.text);
        pill.setAttribute('title', flag.hint);
        meta.append(pill);
      }
      row.append(top, title, meta);

      // The roster is interactive, so it sits beside the link rather than inside it.
      const entry = this.el('div', 'cdp-news-entry');
      entry.append(row);
      const roster = describePublisherRoster(corroboration, publisherRoster(evidence));
      if (roster) entry.append(renderPublisherRosterElement(roster));

      if (i >= 3) {
        const wrapper = this.el('div', 'cdp-expanded-only');
        wrapper.append(entry);
        this.newsBody.append(wrapper);
      } else {
        this.newsBody.append(entry);
      }
    }
    const more = this.el('button', 'cdp-inline-action cdp-summary-only', `Read all ${deduped.length} headlines ↗`);
    more.type = 'button';
    more.addEventListener('click', () => {
      this.presentation?.selectTopic('security');
      this.newsBody?.closest('section')?.scrollIntoView({ block: 'start' });
    });
    if (deduped.length > 3) this.newsBody.append(more);
  }


  public updateMilitaryActivity(summary: CountryDeepDiveMilitarySummary | null): void {
    this.currentMilitarySummary = summary;
    const card = this.militaryBody?.closest('section');
    if (card) card.dataset.briefCoverage = summary ? summary.coverage ?? 'complete' : 'partial';
    this.renderMilitaryActivity();
  }

  public refreshHostedSections(): void {
    if (this.source?.mode !== 'host' || !this.currentCode) return;
    this.renderAtlasExposure(true);
  }

  private renderMilitaryActivity(): void {
    if (!this.militaryBody) return;
    this.militaryBody.replaceChildren();

    const summary = this.currentMilitarySummary;
    if (summary) {
      const stats = this.el('div', 'cdp-military-grid');
      stats.append(
        this.metric(t('countryBrief.ownFlights'), summary.ownFlights === null ? 'Unavailable' : String(summary.ownFlights), 'cdp-chip-neutral'),
        this.metric(t('countryBrief.foreignFlights'), summary.foreignFlights === null ? 'Unavailable' : String(summary.foreignFlights), (summary.foreignFlights ?? 0) > 0 ? 'cdp-chip-danger' : 'cdp-chip-neutral'),
        this.metric(t('countryBrief.navalVessels'), summary.nearbyVessels === null ? 'Unavailable' : String(summary.nearbyVessels), 'cdp-chip-neutral'),
        this.metric(t('countryBrief.foreignPresence'), summary.foreignPresence === null ? 'Unknown' : summary.foreignPresence ? t('countryBrief.detected') : t('countryBrief.notDetected'), summary.foreignPresence === null ? 'cdp-chip-neutral' : summary.foreignPresence ? 'cdp-chip-danger' : 'cdp-chip-success'),
      );
      this.militaryBody.append(stats);
      for (const note of summary.coverageNotes ?? []) this.militaryBody.append(this.el('p', 'cdp-economic-source', note));

      const basesTitle = this.el('div', 'cdp-subtitle', t('countryBrief.nearestBases'));
      this.militaryBody.append(basesTitle);
      if (summary.nearestBases.length === 0) {
        this.militaryBody.append(this.makeEmpty(t('countryBrief.noBasesNearby')));
      } else {
        const list = this.el('ul', 'cdp-base-list');
        for (const base of summary.nearestBases.slice(0, 3)) {
          const item = this.el('li', 'cdp-base-item');
          item.append(
            this.el('span', 'cdp-base-name', base.name),
            this.el('span', 'cdp-base-distance', `${Math.round(base.distanceKm)} km`),
          );
          list.append(item);
        }
        this.militaryBody.append(list);
      }
    }

    if (!summary) this.militaryBody.append(this.makeEmpty('Live flight and vessel observations are unavailable in this view.'));
  }

  public updateInfrastructure(countryCode: string): void {
    if (!this.infrastructureBody) return;
    this.infrastructureBody.replaceChildren();

    const centroid = getCountryCentroid(countryCode, ME_STRIKE_BOUNDS);
    if (!centroid) {
      this.infrastructureBody.append(this.makeEmpty(t('countryBrief.noGeometry')));
      return;
    }

    const assets = getCountryInfrastructure(centroid.lat, centroid.lon, countryCode, INFRA_TYPES);
    if (assets.length === 0) {
      this.infrastructureBody.append(this.makeEmpty(t('countryBrief.noInfrastructure')));
      return;
    }

    this.infrastructureByType.clear();
    for (const type of INFRA_TYPES) {
      const matches = assets.filter((asset) => asset.type === type);
      this.infrastructureByType.set(type, matches);
    }

    const grid = this.el('div', 'cdp-infra-grid');
    for (const type of INFRA_TYPES) {
      const list = this.infrastructureByType.get(type) ?? [];
      if (list.length === 0) continue;
      const card = this.el('button', 'cdp-infra-card');
      card.setAttribute('type', 'button');
      card.addEventListener('click', () => this.highlightInfrastructure(type));

      const icon = this.el('span', 'cdp-infra-icon', INFRA_ICONS[type]);
      const label = this.el('span', 'cdp-infra-label', t(`countryBrief.infra.${type}`));
      const count = this.el('span', 'cdp-infra-count', String(list.length));
      card.append(icon, label, count);
      grid.append(card);
    }
    this.infrastructureBody.append(grid);

    const expandedDetails = this.el('div', 'cdp-expanded-only');
    for (const type of INFRA_TYPES) {
      const list = this.infrastructureByType.get(type) ?? [];
      if (list.length === 0) continue;
      const typeLabel = this.el('div', 'cdp-subtitle', `${INFRA_ICONS[type]} ${t(`countryBrief.infra.${type}`)}`);
      expandedDetails.append(typeLabel);
      const ul = this.el('ul', 'cdp-base-list');
      for (const asset of list.slice(0, 5)) {
        const li = this.el('li', 'cdp-base-item');
        li.append(
          this.el('span', 'cdp-base-name', asset.name),
          this.el('span', 'cdp-base-distance', `${Math.round(asset.distanceKm)} km`),
        );
        ul.append(li);
      }
      expandedDetails.append(ul);
    }

    const nearbyPorts = PORTS
      .map((port) => ({
        ...port,
        distanceKm: haversineDistanceKm(centroid.lat, centroid.lon, port.lat, port.lon),
      }))
      .filter((port) => port.distanceKm <= 1500)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 5);

    if (nearbyPorts.length > 0) {
      const portsTitle = this.el('div', 'cdp-subtitle', `\u2693 ${t('countryBrief.nearbyPorts')}`);
      expandedDetails.append(portsTitle);
      const portList = this.el('ul', 'cdp-base-list');
      for (const port of nearbyPorts) {
        const li = this.el('li', 'cdp-base-item');
        li.append(
          this.el('span', 'cdp-base-name', `${port.name} (${port.type})`),
          this.el('span', 'cdp-base-distance', `${Math.round(port.distanceKm)} km`),
        );
        portList.append(li);
      }
      expandedDetails.append(portList);
    }

    this.infrastructureBody.append(expandedDetails);
  }

  public updateEconomicIndicators(indicators: CountryDeepDiveEconomicIndicator[]): void {
    this.economicIndicators = indicators;
    this.renderEconomicIndicators();
  }

  public updateChinaCountrySummary(data: ChinaCountrySummaryData): void {
    if (this.currentCode?.toUpperCase() !== 'CN' || !this.chinaSummaryBody) return;
    this.renderChinaCountrySummary(data.groups);
  }

  public updateCountryFacts(data: CountryFactsData): void {
    if (!this.factsBody) return;
    this.factsBody.replaceChildren();

    if (!data.headOfState && !data.wikipediaSummary && data.population === 0 && !data.capital) {
      this.factsBody.append(this.makeEmpty(t('countryBrief.noFacts')));
      return;
    }

    if (data.wikipediaThumbnailUrl) {
      const img = this.el('img', 'cdp-facts-thumbnail');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = sanitizeUrl(data.wikipediaThumbnailUrl);
      this.factsBody.append(img);
    }

    if (data.wikipediaSummary) {
      const summaryText = data.wikipediaSummary.length > 300
        ? data.wikipediaSummary.slice(0, 300) + '...'
        : data.wikipediaSummary;
      this.factsBody.append(this.el('p', 'cdp-facts-summary', summaryText));
    }

    const grid = this.el('div', 'cdp-facts-grid');

    const popStr = data.population >= 1_000_000_000
      ? `${(data.population / 1_000_000_000).toFixed(1)}B`
      : data.population >= 1_000_000
        ? `${(data.population / 1_000_000).toFixed(1)}M`
        : data.population.toLocaleString();
    grid.append(this.factItem(t('countryBrief.facts.population'), popStr));
    grid.append(this.factItem(t('countryBrief.facts.capital'), data.capital));
    grid.append(this.factItem(t('countryBrief.facts.area'), `${data.areaSqKm.toLocaleString()} km\u00B2`));

    const rawTitle = data.headOfStateTitle || '';
    const hosLabel = rawTitle.length > 30 ? t('countryBrief.facts.headOfState') : (rawTitle || t('countryBrief.facts.headOfState'));
    grid.append(this.factItem(hosLabel, data.headOfState));
    grid.append(this.factItem(t('countryBrief.facts.languages'), data.languages.join(', ')));
    grid.append(this.factItem(t('countryBrief.facts.currencies'), data.currencies.join(', ')));

    this.factsBody.append(grid);
  }

  public updateHousingCycle(data: {
    residential?: { indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string } | null;
    commercial?: { indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string } | null;
    dsr?: { dsrPct: number; change: number | null; period: string } | null;
  } | null): void {
    if (!this.housingBody) return;
    this.housingBody.replaceChildren();
    if (!data || (!data.residential && !data.commercial && !data.dsr)) {
      this.housingBody.append(this.makeEmpty('No BIS housing cycle data for this country'));
      return;
    }
    const grid = this.el('div', 'cdp-housing-grid');
    const measures = [
      { label: 'Residential property', value: data.residential?.indexValue, unit: 'Real price index', change: data.residential?.yoyChange, period: data.residential?.period, comparison: 'year over year' },
      { label: 'Commercial property', value: data.commercial?.indexValue, unit: 'Real price index', change: data.commercial?.yoyChange, period: data.commercial?.period, comparison: 'year over year' },
      { label: 'Household debt service', value: data.dsr?.dsrPct, unit: '% of income', change: data.dsr?.change, period: data.dsr?.period, comparison: 'quarter over quarter' },
    ];
    for (const measure of measures) {
      const tile = this.el('div', 'cdp-housing-measure');
      const available = measure.value != null && Number.isFinite(measure.value);
      tile.append(this.el('h4', '', measure.label),
        this.el('div', 'cdp-metric-hero', available ? measure.value!.toFixed(1) : '—'),
        this.el('div', 'cdp-measure-note', available ? measure.unit : 'Not available'));
      const change = measure.change;
      if (change != null && Number.isFinite(change)) {
        const direction = change > 0 ? '↑ Rising' : change < 0 ? '↓ Falling' : '→ Unchanged';
        tile.append(this.el('div', 'cdp-measure-change', `${this.formatPctTrend(change)} · ${direction}`),
          this.el('div', 'cdp-measure-note', measure.comparison));
      }
      tile.append(this.el('div', 'cdp-economic-source', `BIS · ${measure.period || 'Period not available'}`));
      grid.append(tile);
    }
    this.housingBody.append(grid);
    this.housingBody.append(this.el('p', 'cdp-measure-note', 'Real prices are adjusted for inflation. Debt service measures household payments relative to income.'));
  }



  private formatPctTrend(pct: number | null | undefined): string {
    if (pct == null || !Number.isFinite(pct)) return '\u2014';
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  public updateEnergyProfile(data: CountryEnergyProfileData): void {
    if (!this.energyBody) return;
    this.renderEnergyProfile(data);
  }

  private renderEnergyProfile(data: CountryEnergyProfileData): void {
    if (!this.energyBody) return;
    this.energyBody.replaceChildren();

    const hasAny = data.mixAvailable || data.jodiOilAvailable || data.ieaStocksAvailable
      || data.jodiGasAvailable || data.gasStorageAvailable || data.electricityAvailable
      || data.emberAvailable || data.sprAvailable || data.importShareAvailable;

    if (!hasAny) {
      this.energyBody.append(this.makeEmpty('Energy data unavailable for this country.'));
      return;
    }

    if (data.mixAvailable) {
      const segments: Array<{ label: string; color: string; value: number }> = [
        { label: 'Coal', color: '#6b6b6b', value: data.coalShare },
        { label: 'Oil', color: '#8B4513', value: data.oilShare },
        { label: 'Gas', color: '#D2691E', value: data.gasShare },
        { label: 'Nuclear', color: '#6A0DAD', value: data.nuclearShare },
        { label: 'Hydro', color: '#1E90FF', value: data.hydroShare },
        { label: 'Wind', color: '#87CEEB', value: data.windShare },
        { label: 'Solar', color: '#FFD700', value: data.solarShare },
        { label: 'Other renew', color: '#32CD32', value: Math.max(0, data.renewShare - data.windShare - data.solarShare - data.hydroShare) },
      ];

      const total = segments.reduce((s, seg) => s + seg.value, 0);
      const norm = total > 0 ? total : 1;

      const wrap = this.el('div', 'cdp-energy-donut-wrap');
      wrap.append(this.buildDonutSvg(segments, norm, 'Primary\nEnergy'));
      const legend = this.el('div', 'cdp-energy-legend');
      for (const seg of segments) {
        const pct = (seg.value / norm) * 100;
        if (pct <= 0.5) continue;
        const row = this.el('div', 'cdp-energy-legend-row');
        const dot = this.el('span', 'cdp-energy-legend-dot');
        dot.style.background = seg.color;
        const label = this.el('span', '', `${seg.label}  ${Math.round(pct)}%`);
        row.append(dot, label);
        legend.append(row);
      }
      wrap.append(legend);
      this.energyBody.append(wrap);

      // mixYear is 0 when OWID reports no electricity mix for the country
      // (the proto zero-value stands in for null). Rendering "Data: 0 (OWID)"
      // reads as a real vintage, so label it unknown instead.
      const src = this.el('div', 'cdp-economic-source', data.mixYear > 0
        ? `Data: ${data.mixYear} (OWID)`
        : 'Data: year unavailable (OWID)');
      this.energyBody.append(src);
    }

    if (data.mixAvailable || data.importShareAvailable) {
      const importPct = data.importShare;
      let color = '#6b7280';
      let labelText = 'Unavailable';
      if (data.importShareAvailable) {
        labelText = importPct < 0 ? 'Net exporter' : `${Math.round(importPct)}%`;
        if (importPct > 60) color = '#ef4444';
        else if (importPct >= 30) color = '#f59e0b';
        else if (importPct > 0) color = '#22c55e';
      }
      const row = this.el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px';
      if (data.importShareAvailable) {
        row.title = `${data.importShareSource}, ${data.importShareYear}`;
      }
      const label = this.el('span', 'cdp-economic-source', 'Import dependency:');
      const badge = this.el('span', '');
      badge.style.cssText = `background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-size:calc(11px * var(--wm-panel-effective-scale, 1))`;
      badge.textContent = labelText;
      row.append(label, badge);
      this.energyBody.append(row);
    }

    if (data.jodiOilAvailable) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      section.append(this.el('div', 'cdp-subtitle', `Oil Product Supply (${data.jodiOilDataMonth})`));

      const table = this.el('table', '');
      table.style.cssText = 'width:100%;font-size:calc(11px * var(--wm-panel-effective-scale, 1));border-collapse:collapse';

      const thead = this.el('thead', '');
      const hr = this.el('tr', '');
      for (const h of ['Product', 'Demand', 'Imports']) {
        const th = this.el('th', '');
        th.textContent = h;
        th.style.cssText = 'text-align:left;color:#aaa;padding:2px 4px';
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);

      const tbody = this.el('tbody', '');
      const rows: Array<{ label: string; demand: number; imports: number }> = [
        { label: 'Gasoline', demand: data.gasolineDemandKbd, imports: data.gasolineImportsKbd },
        { label: 'Diesel', demand: data.dieselDemandKbd, imports: data.dieselImportsKbd },
        { label: 'Jet fuel', demand: data.jetDemandKbd, imports: data.jetImportsKbd },
        { label: 'LPG', demand: data.lpgDemandKbd, imports: data.lpgImportsKbd },
      ];
      for (const r of rows) {
        const tr = this.el('tr', '');
        const fmtKbd = (v: number) => v > 0 ? `${v} kbd` : '\u2014';
        for (const val of [r.label, fmtKbd(r.demand), fmtKbd(r.imports)]) {
          const td = this.el('td', '');
          td.textContent = val;
          td.style.cssText = 'padding:2px 4px';
          tr.append(td);
        }
        tbody.append(tr);
      }
      if (data.crudeImportsKbd > 0) {
        const tr = this.el('tr', '');
        for (const val of ['Crude', '\u2014', `${data.crudeImportsKbd} kbd`]) {
          const td = this.el('td', '');
          td.textContent = val;
          td.style.cssText = 'padding:2px 4px';
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      section.append(table);
      section.append(this.el('div', 'cdp-economic-source', 'Source: JODI'));
      this.energyBody.append(section);
    }

    if (data.jodiGasAvailable) {
      // seed-jodi-gas publishes ONE month of TOTDEMO (dataMonth = YYYY-MM), so
      // TJ/36000 is bcm for that single month. Label it BCM/mo — annualizing
      // x12 would fabricate a season-free yearly figure from one data point.
      const totalBcmMonth = Math.round(data.gasTotalDemandTj / 36000);
      const lngShare = data.gasLngShare;
      const pipeShare = Math.max(0, 100 - lngShare);
      const lngColor = lngShare > 80 ? '#ef4444' : lngShare >= 40 ? '#f59e0b' : '#22c55e';

      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const row = this.el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:calc(12px * var(--wm-panel-effective-scale, 1))';

      const gasMonth = data.jodiGasDataMonth ? ` (${data.jodiGasDataMonth})` : '';
      const gasLabel = this.el('span', '', `Gas demand${gasMonth}: ${totalBcmMonth} BCM/mo`);
      const lngBadge = this.el('span', '');
      lngBadge.style.cssText = `background:${lngColor};color:#fff;padding:1px 5px;border-radius:3px;font-size:calc(11px * var(--wm-panel-effective-scale, 1))`;
      lngBadge.textContent = `LNG ${lngShare.toFixed(0)}%`;
      const pipeBadge = this.el('span', '');
      pipeBadge.style.cssText = 'background:#6b7280;color:#fff;padding:1px 5px;border-radius:3px;font-size:calc(11px * var(--wm-panel-effective-scale, 1))';
      pipeBadge.textContent = `Pipeline ${pipeShare.toFixed(0)}%`;

      row.append(gasLabel, lngBadge, pipeBadge);
      section.append(row);
      this.energyBody.append(section);
    }

    if (data.ieaStocksAvailable) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';

      if (data.ieaNetExporter) {
        const msg = this.el('div', '');
        msg.style.cssText = 'color:#22c55e;font-size:calc(12px * var(--wm-panel-effective-scale, 1))';
        msg.textContent = 'IEA oil stocks: Net Exporter';
        section.append(msg);
      } else {
        const coverLabel = this.el('div', '');
        coverLabel.style.cssText = 'font-size:calc(12px * var(--wm-panel-effective-scale, 1));margin-bottom:4px;display:flex;align-items:center;gap:6px';
        const txt = this.el('span', '', `IEA Oil Stocks: ${data.ieaDaysOfCover} days of cover`);
        coverLabel.append(txt);

        if (data.ieaBelowObligation) {
          const warn = this.el('span', '');
          warn.style.cssText = 'background:#ef4444;color:#fff;padding:1px 5px;border-radius:3px;font-size:calc(11px * var(--wm-panel-effective-scale, 1))';
          warn.textContent = 'Below 90-day obligation';
          coverLabel.append(warn);
        }
        section.append(coverLabel);

        const barOuter = this.el('div', '');
        barOuter.style.cssText = 'position:relative;width:100%;height:8px;border-radius:4px;background:#374151;overflow:visible';
        const fillPct = Math.min(data.ieaDaysOfCover / 180 * 100, 100);
        const fill = this.el('div', '');
        fill.style.cssText = `width:${fillPct}%;height:100%;background:#3b82f6;border-radius:4px`;
        const marker = this.el('div', '');
        marker.style.cssText = 'position:absolute;top:-2px;left:50%;width:2px;height:12px;background:#f59e0b;transform:translateX(-50%)';
        barOuter.append(fill, marker);
        section.append(barOuter);
      }
      this.energyBody.append(section);
    }

    if (data.sprAvailable && data.sprRegime === 'government_spr' && !data.sprIeaMember) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const row = this.el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:calc(12px * var(--wm-panel-effective-scale, 1))';
      const badge = this.el('span', '');
      badge.style.cssText = 'background:#3b82f6;color:#fff;padding:1px 6px;border-radius:3px;font-size:calc(11px * var(--wm-panel-effective-scale, 1))';
      const capText = data.sprCapacityMb > 0 ? ` (${data.sprCapacityMb}Mb)` : '';
      badge.textContent = `Strategic Reserve: ${data.sprOperator || 'Government SPR'}${capText}`;
      row.append(badge);
      section.append(row);
      this.energyBody.append(section);
    } else if (data.sprAvailable && data.sprRegime === 'spare_capacity') {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const muted = this.el('div', '');
      muted.style.cssText = 'color:#6b7280;font-size:calc(11px * var(--wm-panel-effective-scale, 1))';
      muted.textContent = 'Spare capacity producer (no formal SPR)';
      section.append(muted);
      this.energyBody.append(section);
    } else if (data.sprAvailable && data.sprRegime === 'none') {
      const note = this.el('div', 'cdp-economic-source');
      note.style.cssText += ';color:#ef4444;opacity:0.7';
      note.textContent = 'No known strategic petroleum reserve program';
      this.energyBody.append(note);
    }

    const hasLiveSignals = data.gasStorageAvailable || data.electricityAvailable;
    if (hasLiveSignals) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      section.append(this.el('div', 'cdp-subtitle', 'Live Signals'));

      if (data.gasStorageAvailable) {
        const row = this.el('div', '');
        row.style.cssText = 'font-size:calc(12px * var(--wm-panel-effective-scale, 1));margin-bottom:4px';
        const deltaSign = data.gasStorageChange1d >= 0 ? '+' : '';
        row.textContent = `EU Gas Storage: ${data.gasStorageFillPct.toFixed(1)}% (${deltaSign}${data.gasStorageChange1d.toFixed(1)}% today, ${data.gasStorageTrend}) as of ${data.gasStorageDate}`;
        section.append(row);
      }

      if (data.electricityAvailable) {
        const row = this.el('div', '');
        row.style.cssText = 'font-size:calc(12px * var(--wm-panel-effective-scale, 1))';
        row.textContent = `Electricity: \u20AC${data.electricityPriceMwh.toFixed(1)}/MWh as of ${data.electricityDate}`;
        section.append(row);
      }
      this.energyBody.append(section);
    }

    if (data.emberAvailable) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const monthLabel = data.emberDataMonth || 'latest';
      section.append(this.el('div', 'cdp-subtitle', `Monthly Generation Mix (${monthLabel})`));

      const segments: Array<{ label: string; color: string; value: number }> = [
        { label: 'Fossil', color: '#8B4513', value: data.emberFossilShare },
        { label: 'Renewable', color: '#22c55e', value: data.emberRenewShare },
        { label: 'Nuclear', color: '#6A0DAD', value: data.emberNuclearShare },
      ];
      const total = segments.reduce((acc, seg) => acc + seg.value, 0);
      const norm = total > 0 ? total : 1;

      const wrap = this.el('div', 'cdp-energy-donut-wrap');
      wrap.append(this.buildDonutSvg(segments, norm, 'Monthly\nMix'));
      const legend = this.el('div', 'cdp-energy-legend');
      for (const seg of segments) {
        const pct = (seg.value / norm) * 100;
        if (pct <= 0.5) continue;
        const row = this.el('div', 'cdp-energy-legend-row');
        const dot = this.el('span', 'cdp-energy-legend-dot');
        dot.style.background = seg.color;
        const label = this.el('span', '', `${seg.label}  ${Math.round(pct)}%`);
        row.append(dot, label);
        legend.append(row);
      }
      wrap.append(legend);
      section.append(wrap);

      if (data.emberCoalShare > 0 || data.emberGasShare > 0) {
        const breakdown = this.el('div', '');
        breakdown.style.cssText = 'font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#aaa;margin-top:4px';
        const parts: string[] = [];
        const fossilR = Math.round(data.emberFossilShare);
        let coalR = Math.round(data.emberCoalShare);
        let gasR = Math.round(data.emberGasShare);
        // Fossil may include oil-burn and other minor categories not surfaced as separate shares;
        // allocate the residual to "Other" so the breakdown sums to the Fossil legend value (see #2971).
        // If independent rounding pushes coal+gas above fossilR, trim the larger of the two so
        // the breakdown never sums above the Fossil legend.
        const overshoot = (coalR + gasR) - fossilR;
        if (overshoot > 0) {
          if (coalR >= gasR) coalR -= overshoot;
          else gasR -= overshoot;
        }
        const otherR = fossilR - coalR - gasR;
        if (coalR > 0) parts.push(`Coal ${coalR}%`);
        if (gasR > 0) parts.push(`Gas ${gasR}%`);
        if (otherR > 0) parts.push(`Other ${otherR}%`);
        breakdown.textContent = `Fossil breakdown: ${parts.join(', ')}`;
        section.append(breakdown);
      }

      if (data.emberDemandTwh > 0) {
        const demand = this.el('div', '');
        demand.style.cssText = 'font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#aaa;margin-top:2px';
        demand.textContent = `Total demand: ${data.emberDemandTwh.toFixed(1)} TWh`;
        section.append(demand);
      }

      section.append(this.el('div', 'cdp-economic-source', 'Source: Ember Climate (monthly)'));
      this.energyBody!.append(section);
    }

    if (data.jodiOilAvailable || data.jodiGasAvailable) {
    }

    // Atlas exposure: pipelines, storage, shortages, disruptions filtered
    // to this country. Reads from the same bootstrap-hydrated stores as
    // the Energy Atlas variant, so the count is free when data is warm
    // and silently absent when a user is on a variant that doesn't
    // pre-hydrate those keys.
    this.renderAtlasExposure();
  }

  private renderAtlasExposure(hostRefresh = false): void {
    if (!this.energyBody) return;
    const iso2 = this.currentCode;
    if (!iso2 || iso2.length !== 2) return;
    if (this.source?.mode === 'host') {
      if (hostRefresh) void this.loadHostedAtlas(iso2, ++this.atlasRevision, this.signal);
      return;
    }
    const signal = this.signal;

    // Late-import so non-energy variants can tree-shake these modules at
    // build time if the Atlas panels aren't bundled. Static imports are
    // safe here because all four stores are pure client caches.
    import('@/shared/pipeline-registry-store').then(({ getCachedPipelineRegistries }) => {
      if (signal.aborted || this.signal !== signal || this.currentCode !== iso2) return;
      const { gas, oil } = getCachedPipelineRegistries() as {
        gas: { pipelines?: Record<string, { fromCountry?: string; toCountry?: string; transitCountries?: string[]; name?: string; id?: string }> } | undefined;
        oil: { pipelines?: Record<string, { fromCountry?: string; toCountry?: string; transitCountries?: string[]; name?: string; id?: string }> } | undefined;
      };
      const touches = (p: { fromCountry?: string; toCountry?: string; transitCountries?: string[] }): boolean =>
        p.fromCountry === iso2 || p.toCountry === iso2 ||
        (Array.isArray(p.transitCountries) && p.transitCountries.includes(iso2));
      const pipes = [
        ...Object.values(gas?.pipelines ?? {}).filter(touches),
        ...Object.values(oil?.pipelines ?? {}).filter(touches),
      ];
      if (pipes.length > 0) {
        this.appendAtlasRow(
          `Pipelines touching ${iso2}`,
          `${pipes.length} pipeline${pipes.length === 1 ? '' : 's'}`,
          pipes.map(p => ({
            id: p.id || '',
            label: p.name || p.id || '',
            event: 'energy:open-pipeline-detail',
            detail: { pipelineId: p.id },
          })),
        );
      }
    }).catch(() => {});

    import('@/shared/storage-facility-registry-store').then(({ getCachedStorageFacilityRegistry }) => {
      if (signal.aborted || this.signal !== signal || this.currentCode !== iso2) return;
      const { registry } = getCachedStorageFacilityRegistry() as {
        registry: { facilities?: Record<string, { country?: string; name?: string; id?: string }> } | undefined;
      };
      const facilities = Object.values(registry?.facilities ?? {}).filter(f => f.country === iso2);
      if (facilities.length > 0) {
        this.appendAtlasRow(
          `Storage in ${iso2}`,
          `${facilities.length} facilit${facilities.length === 1 ? 'y' : 'ies'}`,
          facilities.map(f => ({
            id: f.id || '',
            label: f.name || f.id || '',
            event: 'energy:open-storage-facility-detail',
            detail: { facilityId: f.id },
          })),
        );
      }
    }).catch(() => {});

    import('@/shared/fuel-shortage-registry-store').then(({ getCachedFuelShortageRegistry }) => {
      if (signal.aborted || this.signal !== signal || this.currentCode !== iso2) return;
      const { registry } = getCachedFuelShortageRegistry() as {
        registry: { shortages?: Record<string, { country?: string; product?: string; severity?: string; id?: string; shortDescription?: string; resolvedAt?: string | null }> } | undefined;
      };
      // Exclude resolved shortages — the drill-down counts ACTIVE crises
      // per country, and rendering resolved rows as active inflates the
      // confirmed/watch severity line. Classifier writes resolvedAt on
      // resolution; raw seed uses null.
      const shortages = Object.values(registry?.shortages ?? {})
        .filter(s => s.country === iso2 && !s.resolvedAt);
      if (shortages.length > 0) {
        const confirmedCount = shortages.filter(s => s.severity === 'confirmed').length;
        const severityLine = confirmedCount > 0
          ? `${confirmedCount} confirmed · ${shortages.length - confirmedCount} watch`
          : `${shortages.length} watch`;
        this.appendAtlasRow(
          `Fuel shortages in ${iso2}`,
          severityLine,
          shortages.map(s => ({
            id: s.id || '',
            label: `${s.product || ''} — ${s.shortDescription || ''}`.trim(),
            event: 'energy:open-fuel-shortage-detail',
            detail: { shortageId: s.id },
          })),
        );
      }
    }).catch(() => {});

    // Disruptions filter (plan §R/#5 decision B). The seeded registry carries
    // denormalised `countries[]` on every event, populated from the referenced
    // pipeline or storage facility. We fetch the full list once (no asset
    // filter) and narrow client-side; the bootstrap payload already contains
    // the registry so this is usually cache-hot. If the RPC round-trip returns
    // nothing, we silently skip — CountryDeepDive is not the primary
    // disruption surface (EnergyDisruptionsPanel is), so an empty row is
    // preferable to a spurious error.
    this.loadDisruptionsForCountry(iso2);
  }

  private async loadHostedAtlas(code: string, revision: number, signal: AbortSignal): Promise<void> {
    const source = this.source!;
    const results = await Promise.allSettled([
      source.supply.listPipelines({ commodityType: '' }, { signal }),
      source.supply.listStorageFacilities({ facilityType: '' }, { signal }),
      source.supply.listFuelShortages({ country: '', product: '', severity: '' }, { signal }),
    ]);
    if (signal.aborted || this.signal !== signal || this.currentCode !== code || this.atlasRevision !== revision) return;
    this.hostedAtlasBody?.replaceChildren();
    const [pipelines, facilities, shortages] = results;
    const previous = this.hostedAtlas?.code === code && this.hostedAtlas.signal === signal ? this.hostedAtlas : null;
    const canRetain = (result: PromiseSettledResult<unknown>) => !(result.status === 'rejected' && result.reason instanceof CountrySectionError && result.reason.state === 'locked');
    const data = this.hostedAtlas = { code, signal,
      pipelines: pipelines.status === 'fulfilled' && Array.isArray(pipelines.value.pipelines) && (!pipelines.value.upstreamUnavailable || pipelines.value.pipelines.length) ? pipelines.value : canRetain(pipelines) ? previous?.pipelines : undefined,
      facilities: facilities.status === 'fulfilled' && Array.isArray(facilities.value.facilities) && (!facilities.value.upstreamUnavailable || facilities.value.facilities.length) ? facilities.value : canRetain(facilities) ? previous?.facilities : undefined,
      shortages: shortages.status === 'fulfilled' && Array.isArray(shortages.value.shortages) && (!shortages.value.upstreamUnavailable || shortages.value.shortages.length) ? shortages.value : canRetain(shortages) ? previous?.shortages : undefined,
    };
    const pipes = data.pipelines?.pipelines.filter(p => p.fromCountry === code || p.toCountry === code || p.transitCountries.includes(code)) ?? [];
    const stores = data.facilities?.facilities.filter(f => f.country === code) ?? [];
    const crises = data.shortages?.shortages.filter(s => s.country === code && !s.resolvedAt) ?? [];
    const confirmed = crises.filter(s => s.severity === 'confirmed').length;
    this.appendAtlasRow(`Pipelines touching ${code}`, `${pipes.length} pipeline${pipes.length === 1 ? '' : 's'}`, pipes.map(p => ({ id: p.id, label: p.name, event: 'energy:open-pipeline-detail', detail: { pipelineId: p.id } })));
    this.appendAtlasRow(`Storage in ${code}`, `${stores.length} facilit${stores.length === 1 ? 'y' : 'ies'}`, stores.map(f => ({ id: f.id, label: f.name, event: 'energy:open-storage-facility-detail', detail: { facilityId: f.id } })));
    this.appendAtlasRow(`Fuel shortages in ${code}`, confirmed ? `${confirmed} confirmed · ${crises.length - confirmed} watch` : `${crises.length} watch`, crises.map(s => ({ id: s.id, label: `${s.product} — ${s.shortDescription}`, event: 'energy:open-fuel-shortage-detail', detail: { shortageId: s.id } })));
    for (const [label, available, result] of [['Pipeline', data.pipelines, pipelines], ['Storage', data.facilities, facilities], ['Fuel shortage', data.shortages, shortages]] as const) {
      if (available?.upstreamUnavailable) this.hostedAtlasBody?.append(this.makeEmpty(`${label} Atlas coverage is partial. Counts include only loaded observations.`));
      if (!available || result.status === 'rejected' || (result.status === 'fulfilled' && result.value.upstreamUnavailable && !available.upstreamUnavailable)) this.hostedAtlasBody?.append(this.makeEmpty(`${label} Atlas ${result.status === 'rejected' && result.reason instanceof CountrySectionError && result.reason.state === 'locked' ? 'data is not authorized by this connection' : 'data unavailable'}. ${available ? 'Previously loaded Atlas observations remain visible.' : 'Other loaded observations remain visible.'}`));
    }
    await this.loadDisruptionsForCountry(code, revision);
  }

  public getAtlasSelection() {
    return this.atlasSelection ? { ...this.atlasSelection, renderedText: this.content.querySelector<HTMLElement>('[data-country-atlas-detail]')?.innerText.slice(0, 6000) ?? '' } : null;
  }

  public async openAtlasDetail(type: 'pipeline' | 'storage' | 'shortage', id: string): Promise<void> {
    const data = this.hostedAtlas;
    const code = this.currentCode;
    const signal = this.signal;
    if (!data || !code || data.code !== code || data.signal !== signal || signal.aborted || this.outputClose || !this.source) throw new Error('Country Atlas data is not ready.');
    const outputController = new AbortController();
    const client = this.source.atlas(code, AbortSignal.any([signal, outputController.signal]));
    const shell = this.content.querySelector<HTMLElement>('.cdp-shell')!;
    const selection = { type, id };
    let detailPanel: import('./Panel').Panel;
    let show: () => Promise<void>;
    if (type === 'pipeline') {
      const rows = data.pipelines?.pipelines.filter(p => p.fromCountry === code || p.toCountry === code || p.transitCountries.includes(code));
      if (!rows?.some(p => p.id === id)) throw new Error('Pipeline is not in this country.');
      const { PipelineStatusPanel } = await import('./PipelineStatusPanel');
      const panel = new PipelineStatusPanel(client); detailPanel = panel;
      show = () => panel.presentDetail({ ...data.pipelines!, pipelines: rows }, id);
    } else if (type === 'storage') {
      const rows = data.facilities?.facilities.filter(f => f.country === code);
      if (!rows?.some(f => f.id === id)) throw new Error('Storage facility is not in this country.');
      const { StorageFacilityMapPanel } = await import('./StorageFacilityMapPanel');
      const panel = new StorageFacilityMapPanel(client); detailPanel = panel;
      show = () => panel.presentDetail({ ...data.facilities!, facilities: rows }, id);
    } else {
      const rows = data.shortages?.shortages.filter(s => s.country === code && !s.resolvedAt);
      if (!rows?.some(s => s.id === id)) throw new Error('Fuel shortage is not active in this country.');
      const { FuelShortagePanel } = await import('./FuelShortagePanel');
      const panel = new FuelShortagePanel(client); detailPanel = panel;
      show = () => panel.presentDetail({ ...data.shortages!, shortages: rows }, id);
    }
    if (signal.aborted || this.signal !== signal || this.currentCode !== code || this.outputClose) { detailPanel.destroy(); return; }
    const output = this.el('div', 'cdp-atlas-output');
    output.dataset.countryAtlasDetail = type;
    const back = this.el('button', 'cdp-action-btn', 'Back to country');
    back.addEventListener('click', () => this.outputClose?.());
    output.addEventListener('click', event => {
      if (!(event.target instanceof Element) || !event.target.closest('.pp-drawer-close, .sf-drawer-close, .fs-drawer-close, .panel-close-btn')) return;
      event.stopImmediatePropagation();
    }, true);
    output.append(back, detailPanel.getElement());
    this.atlasSelection = selection;
    shell.hidden = true; this.content.append(output); this.content.scrollTop = 0; back.focus();
    await show();
  }

  private async loadDisruptionsForCountry(iso2: string, revision = this.atlasRevision): Promise<void> {
    const abortSignal = this.signal;
    try {
      const { SupplyChainServiceClient } = await import(
        '@/generated/client/worldmonitor/supply_chain/v1/service_client'
      );
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      // Thread the panel's `signal` into the fetch shim so a country
      // switch or panel close cancels the in-flight request, not just
      // discards the result via the `this.currentCode !== iso2` guard
      // below. Codex P2 on PR #3377.
      const client = this.source?.supply ?? new SupplyChainServiceClient(getRpcBaseUrl(), {
        fetch: (input, init) => globalThis.fetch(input, { ...(init ?? {}), signal: abortSignal }),
      });
      const res = await client.listEnergyDisruptions({
        assetId: '',
        assetType: '',
        ongoingOnly: false,
      }, { signal: abortSignal });
      if (!res || !Array.isArray(res.events) || abortSignal.aborted || this.signal !== abortSignal || this.currentCode !== iso2 || this.atlasRevision !== revision) return;
      const events = res.events.filter(e =>
        Array.isArray(e.countries) && e.countries.includes(iso2),
      );
      if (events.length === 0) return;
      const ongoing = events.filter(e => !e.endAt).length;
      const summary = ongoing > 0
        ? `${ongoing} ongoing · ${events.length - ongoing} resolved`
        : `${events.length} resolved`;
      this.appendAtlasRow(
        `Energy disruptions in ${iso2}`,
        summary,
        events.map(e => ({
          id: e.id,
          // Clamp long descriptions (some registry entries run 100-200
          // chars, e.g. OFAC designation paragraphs) so the row layout
          // stays compact. 80-char limit + ellipsis. Codex P2 on PR #3377.
          label: truncateDisruptionLabel(e.eventType, e.shortDescription),
          // Event type mirrors the existing asset-detail events (pipeline /
          // storage) because disruptions reference the underlying asset; the
          // panel-layout listener routes to the matching asset panel.
          event: e.assetType === 'storage'
            ? 'energy:open-storage-facility-detail'
            : 'energy:open-pipeline-detail',
          // Emit ONLY the {pipelineId, facilityId} the drawers consume today
          // (see PipelineStatusPanel + StorageFacilityMapPanel
          // openDetailHandler). Previously this detail included a
          // `highlightEventId` that no receiver read — Codex P2 flagged the
          // misleading API surface. Clicking a row jumps to the asset
          // drawer; the user sees the full per-asset timeline and locates
          // the event visually. Re-add `highlightEventId` here and in
          // EnergyDisruptionsPanel's dispatchOpenAsset only when the
          // drawer panels ship matching consumer code.
          detail: e.assetType === 'storage'
            ? { facilityId: e.assetId }
            : { pipelineId: e.assetId },
        })),
      );
    } catch {
      // Silent — disruptions row is supplementary; failures elsewhere
      // surface via the dedicated EnergyDisruptionsPanel. Abort errors
      // from signal cancellation are also swallowed here intentionally.
    }
  }

  private appendAtlasRow(
    title: string,
    summary: string,
    items: Array<{ id: string; label: string; event: string; detail: Record<string, string | undefined> }>,
  ): void {
    const body = this.hostedAtlasBody ?? this.energyBody;
    if (!body || items.length === 0) return;
    const section = this.el('div', '');
    section.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)';
    const header = this.el('div', '');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px';
    header.append(this.el('div', 'cdp-subtitle', title));
    header.append(this.el('div', 'cdp-economic-source', summary));
    section.append(header);
    for (const it of items.slice(0, 5)) {
      const row = this.el('button', 'cdp-action-btn');
      row.style.cssText = 'font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#ddd;padding:2px 0;cursor:pointer';
      row.textContent = it.label || it.id;
      row.addEventListener('click', () => {
        if (!it.id) return;
        if (this.source?.mode === 'host') {
          const type = it.event === 'energy:open-pipeline-detail' ? 'pipeline' : it.event === 'energy:open-storage-facility-detail' ? 'storage' : 'shortage';
          const id = it.detail.pipelineId ?? it.detail.facilityId ?? it.detail.shortageId ?? it.id;
          void this.openAtlasDetail(type, id).catch(() => showToast('Atlas detail is not available. Please retry.'));
          return;
        }
        try {
          window.dispatchEvent(new CustomEvent(it.event, { detail: it.detail }));
        } catch { /* Non-browser runtime no-op */ }
      });
      section.append(row);
    }
    if (items.length > 5) {
      const more = this.el('div', 'cdp-economic-source', `+${items.length - 5} more`);
      section.append(more);
    }
    body.append(section);
  }

  private buildDonutSvg(
    segments: Array<{ label: string; color: string; value: number }>,
    norm: number,
    centerText: string,
  ): HTMLElement {
    const size = 120;
    const r = 46;
    const stroke = 18;
    const cx = size / 2;
    const cy = size / 2;
    const circ = 2 * Math.PI * r;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

    let offset = 0;
    for (const seg of segments) {
      const pct = (seg.value / norm) * 100;
      if (pct <= 0.5) continue;
      const dash = (pct / 100) * circ;
      const gap = circ - dash;
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', seg.color);
      circle.setAttribute('stroke-width', String(stroke));
      circle.setAttribute('stroke-dasharray', `${dash} ${gap}`);
      circle.setAttribute('stroke-dashoffset', String(-offset));
      svg.append(circle);
      offset += dash;
    }

    const wrap = this.el('div', 'cdp-energy-donut');
    wrap.append(svg);
    const label = this.el('div', 'cdp-energy-donut-label');
    label.textContent = centerText;
    wrap.append(label);
    return wrap;
  }

  public updateMaritimeActivity(data: CountryPortActivityData): void {
    if (!this.maritimeBody) return;

    if (!data.available || data.ports.length === 0) {
      this.maritimeBody.replaceChildren(this.makeEmpty('No maritime activity data available for this country.'));
      return;
    }

    this.maritimeBody.replaceChildren();

    const table = this.el('table', 'cdp-maritime-table');
    const thead = this.el('thead');
    const headerRow = this.el('tr');
    for (const col of ['Port', 'Tanker Calls (30d)', 'Trend', 'Import DWT', 'Export DWT']) {
      const th = this.el('th', '', col);
      headerRow.append(th);
    }
    thead.append(headerRow);
    table.append(thead);

    const tbody = this.el('tbody');
    for (const port of data.ports) {
      const tr = this.el('tr');

      const nameCell = this.el('td', 'cdp-maritime-port');
      nameCell.textContent = port.portName;
      if (port.anomalySignal) {
        const badge = this.el('span', 'cdp-maritime-anomaly', '\u26A0');
        badge.title = 'Traffic anomaly detected';
        nameCell.append(badge);
      }
      tr.append(nameCell);

      const callsCell = this.el('td', '', String(port.tankerCalls30d));
      tr.append(callsCell);

      const trendCell = this.el('td', 'cdp-maritime-trend');
      const pct = port.trendDeltaPct;
      if (pct !== 0 || port.tankerCalls30d > 0) {
        const sign = pct > 0 ? '+' : '';
        trendCell.textContent = `${sign}${pct.toFixed(1)}%`;
        if (pct > 0) trendCell.classList.add('cdp-trend-up');
        else if (pct < 0) trendCell.classList.add('cdp-trend-down');
      } else {
        trendCell.textContent = 'n/a';
      }
      tr.append(trendCell);

      const fmtDwt = (v: number): string =>
        v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : String(Math.round(v));

      tr.append(this.el('td', '', fmtDwt(port.importTankerDwt)));
      tr.append(this.el('td', '', fmtDwt(port.exportTankerDwt)));

      tbody.append(tr);
    }
    table.append(tbody);
    const scrollWrap = this.el('div', 'cdp-maritime-scroll');
    scrollWrap.append(table);
    this.maritimeBody.append(scrollWrap);

    if (data.fetchedAt) {
      const dateStr = data.fetchedAt.split('T')[0] ?? data.fetchedAt;
      const footer = this.el('div', 'cdp-section-source', `Source: IMF PortWatch \u00B7 as of ${dateStr}`);
      this.maritimeBody.append(footer);
    }
  }

  private factItem(label: string, value: string): HTMLElement {
    const wrapper = this.el('div', 'cdp-fact-item');
    wrapper.append(this.el('div', 'cdp-fact-label', label));
    wrapper.append(this.el('div', '', value));
    return wrapper;
  }

  public isFallbackBrief(): boolean {
    return this.currentBriefIsFallback;
  }

  public updateScore(score: CountryScore | null, _signals: CountrySignalCounts | null): void {
    if (_signals) {
      this.currentSignals = _signals;
      this.signalsBody?.querySelector('.cdp-signal-chips')?.replaceWith(this.buildSignalChipsElement(_signals));
      if (!this.currentSignalDetails) this.renderInitialSignalBreakdown(_signals);
    }
    if (!this.scoreCard) return;
    // Partial DOM update: score number, level color, trend, component bars only
    const top = this.scoreCard.firstElementChild as HTMLElement | null;
    while (this.scoreCard.childElementCount > 1) {
      this.scoreCard.lastElementChild?.remove();
    }
    if (top) {
      const updatedEl = top.querySelector('.cdp-updated');
      if (updatedEl) updatedEl.textContent = `Updated ${score?.lastUpdated ? this.shortDate(score.lastUpdated) : '—'}`;
    }
    if (score) {
      const band = ciiBandForLevel(score.level);
      const scoreRow = this.el('div', 'cdp-score-row');
      const value = this.el('div', `cdp-score-value cii-${band}`, `${score.score}/100`);
      const trend = this.el('div', `cdp-trend cii-${band}`, `${score.level} · ${this.trendArrow(score.trend)} ${score.trend}`);
      scoreRow.append(value, trend);
      this.scoreCard.append(scoreRow);
      this.scoreCard.append(this.renderComponentBars(score.components));
      this.scoreCard.append(this.el('p', 'cdp-measure-note', 'Higher means more instability.'));
    } else {
      this.scoreCard.append(this.makeEmpty(t('countryBrief.ciiUnavailable')));
    }
  }

  public updateStock(data: StockIndexData): void {
    if (!data.available) {
      this.renderEconomicIndicators();
      return;
    }

    const delta = Number.parseFloat(data.weekChangePercent);
    const trend: TrendDirection = Number.isFinite(delta)
      ? delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
      : 'flat';

    const base = this.economicIndicators.filter((item) => item.label !== 'Stock Index' && item.label !== 'Weekly Momentum');
    const weeklyValue = data.weekChangePercent.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(weeklyValue) && Number.isFinite(delta)) {
      base.unshift({
        label: 'Weekly Momentum',
        value: `${delta >= 0 ? '+' : ''}${data.weekChangePercent}%`,
        trend,
      });
    }
    base.unshift({
      label: 'Stock Index',
      value: `${data.indexName}: ${data.price} ${data.currency}`,
      trend,
      source: 'Market Service',
    });
    this.economicIndicators = base.slice(0, 6);
    this.renderEconomicIndicators();
  }

  public updateMarkets(markets: PredictionMarket[]): void {
    if (!this.marketsBody) return;
    this.marketsBody.replaceChildren();

    if (markets.length === 0) {
      this.marketsBody.append(this.makeEmpty(t('countryBrief.noMarkets')));
      return;
    }

    for (const market of markets.slice(0, 5)) {
      const item = this.el('div', 'cdp-market-item');
      const top = this.el('div', 'cdp-market-top');
      const title = this.el('div', 'cdp-market-title', market.title);
      top.append(title);

      const link = sanitizeUrl(market.url || '');
      if (link) {
        const anchor = this.el('a', 'cdp-market-link', 'Open');
        anchor.setAttribute('href', link);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener');
        top.append(anchor);
      }

      const prob = this.el('div', 'cdp-market-prob', `Probability: ${Math.round(market.yesPrice)}%`);
      const source = market.source === 'kalshi' ? 'Kalshi' : 'Polymarket';
      const meta = this.el('div', 'cdp-market-meta');
      const sourceBadge = this.el('span', 'prediction-source', source);
      sourceBadge.dataset.source = market.source === 'kalshi' ? 'kalshi' : 'polymarket';
      meta.append(sourceBadge, document.createTextNode(market.endDate ? ` Ends ${this.shortDate(market.endDate)}` : ' Active'));
      item.append(top, prob, meta);

      const expanded = this.el('div', 'cdp-expanded-only');
      if (market.volume != null) {
        expanded.append(this.el('div', 'cdp-market-volume', `Volume: $${market.volume.toLocaleString()}`));
      }
      const yesPercent = Math.round(market.yesPrice);
      const noPercent = 100 - yesPercent;
      const bar = this.el('div', 'cdp-market-bar');
      const barYes = this.el('div', 'cdp-market-bar-yes');
      barYes.style.width = `${yesPercent}%`;
      const barNo = this.el('div', 'cdp-market-bar-no');
      barNo.style.width = `${noPercent}%`;
      bar.append(barYes, barNo);
      expanded.append(bar);
      item.append(expanded);

      this.marketsBody.append(item);
    }
  }

  public updateBrief(data: CountryIntelData): void {
    if (!this.briefBody || data.code !== this.currentCode) return;
    this.briefBody.replaceChildren();

    if (data.error || data.skipped || !data.brief) {
      this.currentBriefIsFallback = false;
      this.briefBody.append(this.makeEmpty(data.error || data.reason || t('countryBrief.assessmentUnavailable')));
      return;
    }

    this.currentBriefIsFallback = data.fallback === true;

    const briefSources = collectBriefSources(data.sources ?? [], 6);
    const summaryHtml = this.formatBrief(summarizeCountryBrief(data.brief), briefSources, 0, data.evidence);
    const text = this.el('div', 'cdp-assessment-text cdp-summary-only');
    setTrustedHtml(text, trustedHtml(summaryHtml, "legacy direct innerHTML migration"));

    const metaTokens: string[] = [];
    if (data.cached) metaTokens.push('Cached');
    if (data.fallback) metaTokens.push('Fallback');
    if (data.generatedAt) metaTokens.push(`Updated ${new Date(data.generatedAt).toLocaleTimeString()}`);
    const meta = this.el('div', 'cdp-assessment-meta', metaTokens.join(' • '));
    this.briefBody.append(text, meta);
    const sourcesFooter = renderBriefSourcesFooter(briefSources, { className: 'cdp-brief-sources' })
      + renderBriefEvidenceFooter(data.evidence, { className: 'cdp-brief-sources cdp-brief-evidence' });
    if (sourcesFooter) {
      const summarySources = this.el('div', 'cdp-summary-only');
      setTrustedHtml(summarySources, trustedHtml(sourcesFooter, "legacy direct innerHTML migration"));
      this.briefBody.append(summarySources);
    }

    const expandedBrief = this.el('div', 'cdp-expanded-only');
    const fullText = this.el('div', 'cdp-assessment-text');
    setTrustedHtml(fullText, trustedHtml(this.formatBrief(data.brief, briefSources, this.currentHeadlineCount, data.evidence), "legacy direct innerHTML migration"));
    expandedBrief.append(fullText);
    if (sourcesFooter) {
      const sources = this.el('div', 'cdp-expanded-only');
      setTrustedHtml(sources, trustedHtml(sourcesFooter, "legacy direct innerHTML migration"));
      expandedBrief.append(sources);
    }
    this.briefBody.append(expandedBrief);
    const readFull = this.el('button', 'cdp-inline-action cdp-summary-only', 'Read the full brief and sources ↗');
    readFull.type = 'button';
    readFull.addEventListener('click', () => this.presentation?.selectTopic('sources'));
    this.briefBody.append(readFull);
  }

  private renderLoading(): void {
    this.resetPanelContent();
    const loading = this.el('div', 'cdp-loading');
    loading.append(
      this.el('div', 'cdp-loading-title', t('countryBrief.identifying')),
      this.el('div', 'cdp-loading-line'),
      this.el('div', 'cdp-loading-line cdp-loading-line-short'),
    );
    this.content.append(loading);
  }

  private renderSkeleton(country: string, code: string, score: CountryScore | null, signals: CountrySignalCounts | null): void {
    this.resetPanelContent();

    const shell = this.el('div', 'cdp-shell');
    const header = this.el('header', 'cdp-header');
    const left = this.el('div', 'cdp-header-left');
    const flag = this.el('span', 'cdp-flag', CountryDeepDivePanel.toFlagEmoji(code));
    const titleWrap = this.el('div', 'cdp-title-wrap');
    const name = this.el('h2', 'cdp-country-name', country);
    const subtitle = this.el('div', 'cdp-country-subtitle', `WORLD MONITOR · COUNTRY BRIEF · ${code.toUpperCase()}`);
    titleWrap.append(subtitle, name);

    // `resetPanelContent` (called at the top of renderSkeleton) already
    // tore down the prior FollowButton's subscriptions; here we just
    // mount a fresh one for the new country.
    const followHost = this.el('span', 'cdp-follow-btn-host');
    followHost.dataset.country = code;
    if (this.source?.mode === 'host') {
      const link = this.el('a', 'cdp-action-btn', 'Follow / notifications on WorldMonitor') as HTMLAnchorElement;
      link.href = `https://www.worldmonitor.app/dashboard?c=${encodeURIComponent(code)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      followHost.append(link);
    } else {
      const handle = renderFollowButton({
        countryCode: code,
        countryName: country,
        size: 'md',
      });
      setTrustedHtml(followHost, trustedHtml(handle.html, "legacy direct innerHTML migration"));
      this.followButtonTeardown = handle.attach(followHost);

    }

    left.append(flag, titleWrap, followHost);

    const right = this.el('div', 'cdp-header-right');

    const maxBtn = this.el('button', 'cdp-maximize-btn', '\u26F6') as HTMLButtonElement;
    maxBtn.setAttribute('type', 'button');
    maxBtn.setAttribute('aria-label', 'Toggle maximize');
    maxBtn.addEventListener('click', () => {
      if (this.isMaximizedState) this.minimize();
      else this.maximize();
    });
    this.maximizeButton = maxBtn;

    const shareBtn = this.el('button', 'cdp-action-btn cdp-share-btn') as HTMLButtonElement;
    shareBtn.setAttribute('type', 'button');
    shareBtn.setAttribute('aria-label', t('components.countryBrief.shareLink'));
    setTrustedHtml(shareBtn, trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>', "legacy direct innerHTML migration"));
    shareBtn.addEventListener('click', () => {
      if (!this.currentCode || !this.currentName) return;
      const url = `${this.source?.mode === 'host' ? 'https://www.worldmonitor.app' : window.location.origin}/dashboard?c=${encodeURIComponent(this.currentCode)}`;
      navigator.clipboard.writeText(url).then(() => {
        const orig = shareBtn.innerHTML;
        setTrustedHtml(shareBtn, trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>', "legacy direct innerHTML migration"));
        setTimeout(() => { setTrustedHtml(shareBtn, trustedHtml(orig, "legacy direct innerHTML migration")); }, 1500);
      }).catch(() => {});
    });

    right.append(shareBtn, maxBtn);
    header.append(left, right);

    const scoreCard = this.el('section', 'cdp-card cdp-score-card');
    this.scoreCard = scoreCard;
    const top = this.el('div', 'cdp-score-top');
    const label = this.el('span', 'cdp-score-label', t('countryBrief.instabilityIndex'));
    const updated = this.el('span', 'cdp-updated', `Updated ${score?.lastUpdated ? this.shortDate(score.lastUpdated) : '—'}`);
    top.append(label, updated);
    scoreCard.append(top);

    if (score) {
      const band = ciiBandForLevel(score.level);
      const scoreRow = this.el('div', 'cdp-score-row');
      const value = this.el('div', `cdp-score-value cii-${band}`, `${score.score}/100`);
      const trend = this.el('div', `cdp-trend cii-${band}`, `${score.level} · ${this.trendArrow(score.trend)} ${score.trend}`);
      scoreRow.append(value, trend);
      scoreCard.append(scoreRow);
      scoreCard.append(this.renderComponentBars(score.components));
      scoreCard.append(this.el('p', 'cdp-measure-note', 'Higher means more instability.'));
    } else {
      scoreCard.append(this.makeEmpty(t('countryBrief.ciiUnavailable')));
    }

    const summaryGrid = this.el('div', 'cdp-summary-grid');
    summaryGrid.append(scoreCard);

    const bodyGrid = this.el('div', 'cdp-grid');
    const [signalsCard, signalBody] = this.sectionCard('signals', t('countryBrief.activeSignals'));
    const [timelineCard, timelineBody] = this.sectionCard('timeline', t('countryBrief.timeline'));
    const [newsCard, newsBody] = this.sectionCard('news', t('countryBrief.topNews'));
    const [militaryCard, militaryBody] = this.sectionCard('military', t('countryBrief.militaryActivity'));
    const [infraCard, infraBody] = this.sectionCard('infrastructure', t('countryBrief.infrastructure'));
    const [economicCard, economicBody] = this.sectionCard('economic', t('countryBrief.economicIndicators'));
    const [housingCard, housingBody] = this.sectionCard(
      'housing',
      'Housing Cycle',
      'BIS quarterly real residential and commercial property price indices plus household debt service ratio — early-warning signals for credit / property cycle turns.',
    );
    const [marketsCard, marketsBody] = this.sectionCard('markets', t('countryBrief.predictionMarkets'));
    const [briefCard, briefBody] = this.sectionCard('assessment', t('countryBrief.intelBrief'));

    const [factsCard, factsBody] = this.sectionCard('facts', t('countryBrief.countryFacts'));
    this.factsBody = factsBody;
    factsBody.append(this.makeLoading(t('countryBrief.loadingFacts')));

    const [energyCard, energyBody] = this.sectionCard('energy', 'Energy Profile', 'Oil import dependency, chokepoint exposure, and energy shock data from JODI, IEA, and PortWatch.');
    this.energyBody = this.source?.mode === 'host' ? this.el('div', 'cdp-energy-metrics') : energyBody;
    if (this.source?.mode === 'host') {
      this.hostedAtlasBody = this.el('div', 'cdp-country-atlas');
      energyBody.append(this.energyBody, this.hostedAtlasBody);
    }
    this.energyBody.append(this.makeLoading('Loading energy data\u2026'));

    const [maritimeCard, maritimeBody] = this.sectionCard('maritime', 'Maritime Activity', 'Port-level tanker call volume and import/export cargo weight over 30 days. ⚠ badge = port running below 50% of its 30-day baseline. Source: IMF PortWatch.');
    this.maritimeBody = maritimeBody;
    maritimeBody.append(this.makeLoading('Loading port activity\u2026'));



    this.signalsBody = signalBody;
    this.timelineBody = timelineBody;
    this.timelineBody.classList.add('cdp-timeline-mount');
    this.newsBody = newsBody;
    this.militaryBody = militaryBody;
    this.infrastructureBody = infraBody;
    this.economicBody = economicBody;
    let chinaSummaryCard: HTMLElement | null = null;
    // Drop any body left over from a previous China render so a non-China
    // country never keeps a detached summary body reachable.
    this.chinaSummaryBody = null;
    if (code.toUpperCase() === 'CN') {
      const [card, body] = this.sectionCard('china', t('countryBrief.china.title'), t('countryBrief.china.description'));
      card.classList.add('cdp-china-summary');
      card.setAttribute('aria-label', t('countryBrief.china.title'));
      this.chinaSummaryBody = body;
      this.renderChinaCountrySummary(
        CHINA_DECISION_SIGNAL_GROUP_IDS.map((id) => ({
          id,
          state: 'loading',
          signals: [],
        })),
      );
      chinaSummaryCard = card;
    }
    this.housingBody = housingBody;
    this.marketsBody = marketsBody;
    this.briefBody = briefBody;

    this.renderInitialSignals(signals);
    newsBody.append(this.makeLoading('Loading country headlines…'));
    militaryBody.append(this.makeLoading('Loading flights, vessels, and nearby bases…'));
    infraBody.append(this.makeLoading('Computing nearby critical infrastructure…'));
    economicBody.append(this.makeLoading('Loading available indicators…'));
    housingBody.append(this.makeLoading('Loading housing cycle data…'));
    marketsBody.append(this.makeLoading(t('countryBrief.loadingMarkets')));
    briefBody.append(this.makeLoading(t('countryBrief.generatingBrief')));

    bodyGrid.append(factsCard, ...(chinaSummaryCard ? [chinaSummaryCard] : []), signalsCard, timelineCard, newsCard, militaryCard, economicCard, housingCard, marketsCard, energyCard, maritimeCard, infraCard);
    const lead = this.el('div', 'cdp-overview-lead');
    lead.append(briefCard, summaryGrid);
    shell.append(header, lead, bodyGrid);
    this.content.append(shell);
    const sectionOrder = [briefCard, ...Array.from(bodyGrid.children)];
    this.sections.sort((a, b) => sectionOrder.indexOf(a.card) - sectionOrder.indexOf(b.card));
    this.presentation = new CountryBriefPresentation(shell, this.sections);
  }



  private tearDownFollowButton(): void {
    if (this.followButtonTeardown) {
      try {
        this.followButtonTeardown();
      } catch {
        /* swallow */
      }
      this.followButtonTeardown = null;
    }
  }

  private resetPanelContent(): void {
    this.currentSignalDetails = null;
    this.presentation?.destroy();
    this.presentation = null;
    this.sections = [];
    this.tearDownFollowButton();
    this.map?.clearHighlightedRoute();
    this.scoreCard = null;
    this.currentMilitarySummary = null;
    this.energyBody = null;
    this.hostedAtlasBody = null;
    this.maritimeBody = null;
    this.chinaSummaryBody = null;
    this.housingBody = null;
    this.content.replaceChildren();
  }

  private buildSignalChipsElement(signals: CountrySignalCounts | null): HTMLElement {
    const chips = this.el('div', 'cdp-signal-chips');
    if (!signals) { chips.append(this.makeEmpty('Dashboard signal observations are unavailable in this host.')); return chips; }
    this.addSignalChip(chips, signals.criticalNews, t('countryBrief.chips.criticalNews'), '🚨', 'conflict');
    this.addSignalChip(chips, signals.protests, t('countryBrief.chips.protests'), '📢', 'protest');
    this.addSignalChip(chips, signals.militaryFlights, t('countryBrief.chips.militaryAir'), '✈️', 'military', `${signals.militaryFlights ?? 'unknown'} near · ${signals.militaryFlightsInCountry ?? 'unknown'} inside borders`);
    this.addSignalChip(chips, signals.militaryVessels, t('countryBrief.chips.navalVessels'), '⚓', 'military', `${signals.militaryVessels ?? 'unknown'} near · ${signals.militaryVesselsInCountry ?? 'unknown'} inside borders`);
    this.addSignalChip(chips, signals.outages, t('countryBrief.chips.outages'), '🌐', 'outage');
    this.addSignalChip(chips, signals.aisDisruptions, t('countryBrief.chips.aisDisruptions'), '🚢', 'outage');
    this.addSignalChip(chips, signals.satelliteFires, t('countryBrief.chips.satelliteFires'), '🔥', 'climate');
    this.addSignalChip(chips, signals.radiationAnomalies, 'Radiation anomalies', '☢️', 'outage');
    if (signals.temporalAnomalies === null) {
      chips.append(this.makeSignalChip(`⏱️ ${t('countryBrief.chips.temporalUnavailable')}`, 'outage'));
    } else {
      this.addSignalChip(chips, signals.temporalAnomalies, t('countryBrief.chips.temporalAnomalies'), '⏱️', 'outage');
    }
    this.addSignalChip(chips, signals.cyberThreats, t('countryBrief.chips.cyberThreats'), '🛡️', 'conflict');
    this.addSignalChip(chips, signals.thermalEscalations, 'Thermal escalations', '🌡️', 'climate');
    this.addSignalChip(chips, signals.earthquakes, t('countryBrief.chips.earthquakes'), '🌍', 'quake');
    if (signals.displacementOutflow === null) {
      chips.append(this.makeSignalChip(`🌊 ${t('countryBrief.chips.displaced')} unavailable`, 'unavailable'));
    } else if (signals.displacementOutflow > 0) {
      const fmt = signals.displacementOutflow >= 1_000_000
        ? `${(signals.displacementOutflow / 1_000_000).toFixed(1)}M`
        : `${(signals.displacementOutflow / 1000).toFixed(0)}K`;
      chips.append(this.makeSignalChip(`🌊 ${fmt} ${t('countryBrief.chips.displaced')}`, 'displacement'));
    }
    this.addSignalChip(chips, signals.climateStress, t('countryBrief.chips.climateStress'), '🌡️', 'climate');
    this.addSignalChip(chips, signals.conflictEvents, t('countryBrief.chips.conflictEvents'), '⚔️', 'conflict');
    this.addSignalChip(chips, signals.activeStrikes, t('countryBrief.chips.activeStrikes'), '💥', 'conflict');
    if (signals.travelAdvisories === null) {
      chips.append(this.makeSignalChip(`⚠️ ${t('countryBrief.chips.advisory')} unavailable`, 'unavailable'));
    } else if (signals.travelAdvisories > 0 && signals.travelAdvisoryMaxLevel) {
      const advLabel = signals.travelAdvisoryMaxLevel === 'do-not-travel' ? t('countryBrief.chips.doNotTravel')
        : signals.travelAdvisoryMaxLevel === 'reconsider' ? t('countryBrief.chips.reconsiderTravel')
        : signals.travelAdvisoryMaxLevel === 'normal' ? t('countryBrief.chips.normalPrecautions')
        : signals.travelAdvisoryMaxLevel === 'info' ? t('components.securityAdvisories.levels.info')
        : t('countryBrief.chips.exerciseCaution');
      chips.append(this.makeSignalChip(`⚠️ ${signals.travelAdvisories} ${t('countryBrief.chips.advisory')}: ${advLabel}`, 'advisory'));
    } else {
      this.addSignalChip(chips, signals.travelAdvisories, t('countryBrief.chips.advisory'), '⚠️', 'advisory');
    }
    this.addSignalChip(chips, signals.orefSirens, t('countryBrief.chips.activeSirens'), '🚨', 'conflict');
    this.addSignalChip(chips, signals.orefHistory24h, t('countryBrief.chips.sirens24h'), '🕓', 'conflict');
    this.addSignalChip(chips, signals.aviationDisruptions, t('countryBrief.chips.aviationDisruptions'), '🚫', 'outage');
    this.addSignalChip(chips, signals.gpsJammingHexes, t('countryBrief.chips.gpsJammingZones'), '📡', 'outage');
    return chips;
  }

  private renderInitialSignals(signals: CountrySignalCounts | null): void {
    this.currentSignalDetails = null;
    if (!this.signalsBody) return;
    this.signalsBody.replaceChildren();
    if (!signals) { this.signalsBody.append(this.makeEmpty('Dashboard signal observations are unavailable in this host.')); return; }

    const chips = this.buildSignalChipsElement(signals);
    this.signalsBody.append(chips);

    this.signalBreakdownBody = this.el('div', 'cdp-signal-breakdown');
    this.signalRecentBody = this.el('div', 'cdp-signal-recent');
    this.signalsBody.append(this.signalBreakdownBody, this.signalRecentBody);

    if (this.renderInitialSignalBreakdown(signals)) this.signalRecentBody.append(this.makeLoading('Loading top high-severity signals…'));
  }

  private renderInitialSignalBreakdown(signals: CountrySignalCounts): boolean {
    if (!this.signalBreakdownBody) return false;
    const sum = (...values: Array<number | null>) => values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
    const critical = sum(signals.criticalNews, signals.activeStrikes);
    const high = sum(signals.militaryFlights, signals.militaryVessels, signals.protests);
    const medium = sum(signals.outages, signals.cyberThreats, signals.aisDisruptions, signals.radiationAnomalies);
    const low = sum(signals.earthquakes, signals.temporalAnomalies, signals.satelliteFires);
    if (critical === null || high === null || medium === null || low === null) {
      this.signalBreakdownBody.replaceChildren(this.makeEmpty('Aggregate severity and recent high-severity observations are unavailable. Military counts alone do not establish these totals.'));
      return false;
    }
    this.renderSignalBreakdown({ critical, high, medium, low, recentHigh: [] });
    return true;
  }

  private addSignalChip(container: HTMLElement, count: number | null, label: string, icon: string, cls: string, tooltip?: string): void {
    if (count === null) { container.append(this.makeSignalChip(`${icon} ${label} unavailable`, 'unavailable')); return; }
    if (count <= 0) return;
    container.append(this.makeSignalChip(`${icon} ${count} ${label}`, cls, tooltip));
  }

  private makeSignalChip(text: string, cls: string, tooltip?: string): HTMLElement {
    const chip = this.el('span', `cdp-signal-chip chip-${cls}`, text);
    if (tooltip) chip.title = tooltip;
    return chip;
  }

  private renderComponentBars(components: CountryScore['components']): HTMLElement {
    const wrap = this.el('div', 'cdp-components');
    const items = [
      { label: t('countryBrief.components.unrest'), value: components.unrest, icon: '📢' },
      { label: t('countryBrief.components.conflict'), value: components.conflict, icon: '⚔' },
      { label: t('countryBrief.components.security'), value: components.security, icon: '🛡️' },
      { label: t('countryBrief.components.information'), value: components.information, icon: '📡' },
    ];
    for (const item of items) {
      const row = this.el('div', 'cdp-score-row');
      const icon = this.el('span', 'cdp-comp-icon', item.icon);
      const label = this.el('span', 'cdp-comp-label', item.label);
      const barOuter = this.el('div', 'cdp-comp-bar');
      const pct = Math.min(100, Math.max(0, item.value));
      const color = pct >= 70 ? getCSSColor('--semantic-critical')
        : pct >= 50 ? getCSSColor('--semantic-high')
        : pct >= 30 ? getCSSColor('--semantic-elevated')
        : getCSSColor('--semantic-normal');
      const barFill = this.el('div', 'cdp-comp-fill');
      barFill.style.width = `${pct}%`;
      barFill.style.background = color;
      barOuter.append(barFill);
      const val = this.el('span', 'cdp-comp-val', String(Math.round(item.value)));
      row.append(icon, label, barOuter, val);
      wrap.append(row);
    }
    return wrap;
  }

  private renderSignalBreakdown(details: CountryDeepDiveSignalDetails): void {
    if (!this.signalBreakdownBody) return;
    this.signalBreakdownBody.replaceChildren();

    this.signalBreakdownBody.append(
      this.metric(t('countryBrief.levels.critical'), String(details.critical), 'cdp-chip-danger'),
      this.metric(t('countryBrief.levels.high'), String(details.high), 'cdp-chip-warn'),
      this.metric(t('countryBrief.levels.moderate'), String(details.medium), 'cdp-chip-neutral'),
      this.metric(t('countryBrief.levels.low'), String(details.low), 'cdp-chip-success'),
    );
  }

  private renderRecentSignals(items: CountryDeepDiveSignalItem[]): void {
    if (!this.signalRecentBody) return;
    this.signalRecentBody.replaceChildren();

    if (items.length === 0) {
      this.signalRecentBody.append(this.makeEmpty(t('countryBrief.noSignals')));
      return;
    }

    for (const item of items.slice(0, 3)) {
      const row = this.el('div', 'cdp-signal-item');
      const line = this.el('div', 'cdp-signal-line');
      line.append(
        this.badge(item.type, 'cdp-type-badge'),
        this.badge(item.severity.toUpperCase(), `cdp-severity-badge sev-${item.severity}`),
      );
      const desc = this.el('div', 'cdp-signal-desc', item.description);
      const ts = this.el('div', 'cdp-signal-time', this.formatRelativeTime(item.timestamp));
      row.append(line, desc, ts);
      this.signalRecentBody.append(row);
    }
  }

  private renderEconomicIndicators(): void {
    if (!this.economicBody) return;
    this.economicBody.replaceChildren();

    if (this.economicIndicators.length === 0) {
      this.economicBody.append(this.makeEmpty(t('countryBrief.noIndicators')));
      return;
    }

    for (const indicator of this.economicIndicators.slice(0, 6)) {
      const row = this.el('div', 'cdp-economic-item');
      const top = this.el('div', 'cdp-economic-top');
      const isMarketRow = indicator.label === 'Stock Index' || indicator.label === 'Weekly Momentum';
      const trendClass = isMarketRow ? `trend-market-${indicator.trend}` : `trend-${indicator.trend}`;
      top.append(
        this.el('span', 'cdp-economic-label', indicator.label),
        this.el('span', `cdp-trend-token ${trendClass}`, this.trendArrowFromDirection(indicator.trend)),
      );
      const value = this.el('div', 'cdp-economic-value', indicator.value);
      row.append(top, value);
      if (indicator.source) {
        row.append(this.el('div', 'cdp-economic-source', indicator.source));
      }
      this.economicBody.append(row);
    }
  }

  private renderChinaCountrySummary(groups: ChinaCountrySummaryGroup[]): void {
    if (!this.chinaSummaryBody) return;

    // The group <section>s are aria-live regions. They must stay in the DOM
    // across updates — screen readers only announce mutations *inside* an
    // existing live region, so tearing the sections down and rebuilding them
    // (the old replaceChildren-the-card approach) meant state transitions
    // like loading→stale were never announced.
    let grid = this.chinaSummaryBody.querySelector<HTMLElement>('.cdp-china-summary-grid');
    if (!grid) {
      this.chinaSummaryBody.replaceChildren();
      grid = this.el('div', 'cdp-china-summary-grid');
      this.chinaSummaryBody.append(grid);
    }

    for (const group of groups) {
      let section = grid.querySelector<HTMLElement>(`[data-group-id="${group.id}"]`);
      if (!section) {
        section = this.el('section', 'cdp-china-summary-group');
        section.setAttribute('data-group-id', group.id);
        section.setAttribute('role', 'status');
        section.setAttribute('aria-live', 'polite');
        grid.append(section);
      }

      // Manager updates push the full five-group snapshot each time any one
      // group resolves; skip untouched groups so unchanged content is not
      // re-announced on every sibling resolution.
      const revision = JSON.stringify(group);
      if (section.dataset.revision === revision) continue;
      section.dataset.revision = revision;

      const groupLabel = this.chinaSummaryGroupLabel(group.id);
      const stateLabel = t(`countryBrief.china.status.${group.state}`);
      section.className = `cdp-china-summary-group cdp-china-summary-group--${group.state}`;
      section.setAttribute('aria-label', `${groupLabel}: ${stateLabel}`);

      const heading = this.el('div', 'cdp-china-summary-heading');
      heading.append(
        this.el('h4', 'cdp-china-summary-title', groupLabel),
        this.el('span', 'cdp-china-summary-state', stateLabel),
      );
      const children: HTMLElement[] = [heading];

      if (group.signals.length === 0) {
        children.push(this.el(
          'div',
          'cdp-china-summary-empty',
          group.unavailableReason || t(`countryBrief.china.status.${group.state}`),
        ));
      } else {
        for (const signal of group.signals) {
          const item = this.el('div', 'cdp-china-summary-signal');
          if (signal.stale) item.dataset.stale = 'true';
          item.append(
            this.el('div', 'cdp-china-summary-signal-label', signal.label),
            this.el('div', 'cdp-china-summary-signal-value', signal.value),
          );
          if (signal.observedAt) {
            item.append(this.el('div', 'cdp-china-summary-attribution', `${t('countryBrief.china.observed')} ${signal.observedAt}`));
          }
          if (signal.publishedAt) {
            item.append(this.el('div', 'cdp-china-summary-attribution', `${t('countryBrief.china.published')} ${signal.publishedAt}`));
          }
          if (signal.effectiveAt) {
            item.append(this.el('div', 'cdp-china-summary-attribution', `${t('countryBrief.china.effective')} ${signal.effectiveAt}`));
          }
          if (signal.sectors?.length) {
            item.append(this.el('div', 'cdp-china-summary-attribution', `${t('countryBrief.china.sectors')} ${signal.sectors.join(', ')}`));
          }
          if (signal.entities?.length) {
            item.append(this.el('div', 'cdp-china-summary-attribution', `${t('countryBrief.china.entities')} ${signal.entities.join(', ')}`));
          }
          if (signal.translationState) {
            item.append(this.el('div', 'cdp-china-summary-attribution', `${t('countryBrief.china.translation')} ${signal.translationState}`));
          }
          const sourceAttribution = this.el('div', 'cdp-china-summary-attribution');
          const sourcePrefix = `${t('countryBrief.china.source')} `;
          const safeHref = signal.sourceUrl ? sanitizeUrl(signal.sourceUrl) : '';
          if (safeHref) {
            sourceAttribution.append(document.createTextNode(sourcePrefix));
            const sourceLink = this.el('a', 'cdp-china-summary-source-link', signal.source);
            sourceLink.setAttribute('href', safeHref);
            sourceLink.setAttribute('target', '_blank');
            sourceLink.setAttribute('rel', 'noopener noreferrer');
            sourceAttribution.append(sourceLink);
          } else {
            sourceAttribution.textContent = `${sourcePrefix}${signal.source}`;
          }
          item.append(sourceAttribution);
          children.push(item);
        }
        if (group.unavailableReason) {
          children.push(this.el('div', 'cdp-china-summary-note', group.unavailableReason));
        }
      }
      section.replaceChildren(...children);
    }
  }

  private chinaSummaryGroupLabel(id: ChinaCountrySummaryGroupId): string {
    const keys: Record<ChinaCountrySummaryGroupId, string> = {
      macro: 'macroSignals',
      'policy-enforcement': 'policyEvents',
      'cross-strait-activity': 'crossStraitActivity',
      'corporate-disclosures': 'corporateDisclosures',
      'corridor-conditions': 'corridorConditions',
      'activity-nowcast': 'activityNowcast',
    };
    return t(`countryBrief.china.${keys[id]}`);
  }

  private highlightInfrastructure(type: AssetType): void {
    if (!this.map) {
      this.infrastructureBody?.querySelector<HTMLElement>('.cdp-expanded-only')?.classList.remove('cdp-expanded-only');
      return;
    }
    const assets = this.infrastructureByType.get(type) ?? [];
    if (assets.length === 0) return;
    this.map.flashAssets(type, assets.map((asset) => asset.id));
  }

  private open(): void {
    if (this.panel.classList.contains('active')) return;
    this.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.panel.classList.add('active');
    this.panel.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', this.handleGlobalKeydown);
    if (isMobileDevice()) {
      this.historyRegistered = true;
      overlayHistory.open('deep-dive', (origin) => this.hide(origin));
    }
    requestAnimationFrame(() => {
      if (this.panel.classList.contains('active')) this.closeButton.focus();
    });
    this.onStateChangeCallback?.({ visible: true, maximized: this.isMaximizedState });
  }

  private close(): void {
    if (!this.panel.classList.contains('active')) return;
    this.panel.classList.remove('active');
    this.panel.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', this.handleGlobalKeydown);
    if (this.lastFocusedElement) this.lastFocusedElement.focus();
  }

  private getFocusableElements(): HTMLElement[] {
    const selectors = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    return Array.from(this.panel.querySelectorAll<HTMLElement>(selectors))
      .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null);
  }

  private getOrCreatePanel(): HTMLElement {
    const existing = document.getElementById('country-deep-dive-panel');
    if (existing) return existing;

    const panel = this.el('aside', 'country-deep-dive');
    panel.id = 'country-deep-dive-panel';
    panel.setAttribute('aria-label', 'Country Intelligence');
    panel.setAttribute('aria-hidden', 'true');

    const shell = this.el('div', 'country-deep-dive-shell');
    const close = this.el('button', 'panel-close', '×') as HTMLButtonElement;
    close.id = 'deep-dive-close';
    close.setAttribute('aria-label', t('common.close'));

    const content = this.el('div', 'panel-content');
    content.id = 'deep-dive-content';
    shell.append(close, content);
    panel.append(shell);
    document.body.append(panel);
    return panel;
  }

  private sectionCard(id: BriefSectionId, title: string, helpText?: string): [HTMLElement, HTMLElement] {
    const card = this.el('section', 'cdp-card');
    card.id = `cdp-section-${id}`;
    card.dataset.briefSection = id;
    card.tabIndex = -1;
    const heading = this.el('h3', 'cdp-card-title', title);
    if (helpText) {
      const tip = this.el('button', 'cdp-card-help', '?');
      tip.setAttribute('title', helpText);
      tip.setAttribute('type', 'button');
      tip.setAttribute('aria-label', `About ${title}`);
      heading.append(tip);
    }
    const body = this.el('div', 'cdp-card-body');
    card.append(heading, body);
    this.sections.push({ id, title, card, body });
    return [card, body];
  }

  private metric(label: string, value: string, chipClass: string): HTMLElement {
    const box = this.el('div', 'cdp-metric');
    box.append(
      this.el('span', 'cdp-metric-label', label),
      this.badge(value, `cdp-metric-value ${chipClass}`),
    );
    return box;
  }

  private makeLoading(text: string): HTMLElement {
    const wrap = this.el('div', 'cdp-loading-inline');
    wrap.append(
      this.el('div', 'cdp-loading-line'),
      this.el('div', 'cdp-loading-line cdp-loading-line-short'),
      this.el('span', 'cdp-loading-text', text),
    );
    return wrap;
  }

  private makeEmpty(text: string): HTMLElement {
    return this.el('div', 'cdp-empty', text);
  }

  private badge(text: string, className: string): HTMLElement {
    return this.el('span', className, text);
  }

  private formatBrief(text: string, sources: BriefSource[] = [], headlineCount = 0, evidence?: IntelBriefEvidence[]): string {
    return formatIntelBrief(
      text,
      sources.length > 0
        ? { sources }
        : headlineCount > 0
          ? { count: headlineCount, hrefPrefix: '#cdp-news-' }
          : undefined,
      this.currentName ?? undefined,
      evidence,
    );
  }


  private trendArrow(trend: CountryScore['trend']): string {
    if (trend === 'rising') return '↑';
    if (trend === 'falling') return '↓';
    return '→';
  }

  private trendArrowFromDirection(trend: TrendDirection): string {
    if (trend === 'up') return '↑';
    if (trend === 'down') return '↓';
    return '→';
  }

  private toThreatLevel(level: string | undefined): ThreatLevel {
    if (level === 'critical' || level === 'high' || level === 'medium' || level === 'low' || level === 'info') {
      return level;
    }
    return 'low';
  }

  private toTimestamp(date: Date | string): number {
    const d = date instanceof Date ? date : new Date(date);
    return Number.isFinite(d.getTime()) ? d.getTime() : 0;
  }

  private shortDate(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Unknown';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private formatRelativeTime(value: Date | string): string {
    const ms = Date.now() - this.toTimestamp(value);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return t('countryBrief.timeAgo.m', { count: 1 });
    if (mins < 60) return t('countryBrief.timeAgo.m', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('countryBrief.timeAgo.h', { count: hours });
    const days = Math.floor(hours / 24);
    return t('countryBrief.timeAgo.d', { count: days });
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (tag === 'th') {
      (node as HTMLTableCellElement).scope = 'col';
    }
    return node;
  }

  public static toFlagEmoji(code: string): string {
    return toFlagEmoji(code, '🌍');
  }
}
