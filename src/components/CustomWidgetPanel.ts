import { Panel } from './Panel';
import type { CustomWidgetSpec } from '@/services/widget-store';
import { wrapWidgetHtml } from '@/utils/widget-sanitizer';
import { unsafeRawHtml } from '@/utils/sanitize';

export class CustomWidgetPanel extends Panel {
  private spec: CustomWidgetSpec;

  constructor(spec: CustomWidgetSpec) {
    super({
      id: spec.id,
      title: spec.title,
      closable: true,
      className: 'custom-widget-panel',
      defaultRowSpan: 2,
    });
    this.spec = spec;
    this.renderWidget();
  }

  renderWidget(): void {
      this.setSafeContent(unsafeRawHtml(wrapWidgetHtml(this.spec.html), 'legacy Panel.setContent() migration'));
    this.applyAccentColor();
  }

  private applyAccentColor(): void {
    if (this.spec.accentColor) {
      this.element.style.setProperty('--widget-accent', this.spec.accentColor);
    } else {
      this.element.style.removeProperty('--widget-accent');
    }
  }

  updateSpec(spec: CustomWidgetSpec): void {
    this.spec = spec;
    const titleEl = this.header.querySelector('.panel-title');
    if (titleEl) titleEl.textContent = spec.title;
    this.renderWidget();
  }

  getSpec(): CustomWidgetSpec {
    return this.spec;
  }
}
