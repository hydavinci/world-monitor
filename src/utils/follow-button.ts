import { addCountry, isFollowed, removeCountry, subscribe } from '@/services/followed-countries';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
export interface FollowButtonProps {
  countryCode: string;
  size?: 'sm' | 'md';
  countryName?: string;
}
export interface FollowButtonHandle { html: string; attach: (host: HTMLElement) => () => void }
export function renderFollowButton(props: FollowButtonProps): FollowButtonHandle {
  const markup = (): string => {
    const followed = isFollowed(props.countryCode);
    const label = `${followed ? 'Unfollow' : 'Follow'} ${props.countryName ?? props.countryCode}`;
    return `<button class="follow-country-btn follow-country-btn--${props.size ?? 'md'}${followed ? ' is-followed' : ''}"
      type="button" aria-pressed="${followed}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${followed ? '★' : '☆'}</button>`;
  };
  return {
    html: markup(),
    attach(host) {
      let stopped = false;
      let busy = false;
      const render = (): void => {
        if (!stopped) setTrustedHtml(host, trustedHtml(markup(), 'Escaped local follow button label'));
      };
      render();
      const unsubscribe = subscribe(render);
      const click = async (): Promise<void> => {
        if (busy || stopped) return;
        busy = true;
        const result = await (isFollowed(props.countryCode) ? removeCountry(props.countryCode) : addCountry(props.countryCode));
        busy = false;
        if (!result.ok && !stopped) host.setAttribute('title', 'Could not save local followed countries');
      };
      host.addEventListener('click', click);
      return () => { stopped = true; unsubscribe(); host.removeEventListener('click', click); };
    },
  };
}
