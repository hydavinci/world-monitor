import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { terminalChart } from '../src/utils/terminal-chart';

test('narrow chart keeps long price labels and plot geometry in its SVG', async ({ page }) => {
  const svg = terminalChart([1234567890120, 1234567890125, 1234567890123.4], { width: 120 });
  await page.setContent(`<style>${readFileSync('src/styles/plugin-market.css', 'utf8')}</style>${svg}`);
  for (const family of ['monospace', 'serif', 'sans-serif']) {
    const bounds = await page.locator('svg').evaluate((element, font) => {
      const chart = element as SVGSVGElement;
      chart.style.fontFamily = font;
      const labels = Array.from(chart.querySelectorAll('text'), label => {
        const box = label.getBBox();
        return { text: label.textContent, left: box.x, right: box.x + box.width };
      });
      return { width: chart.viewBox.baseVal.width, labels, lastX: Number(chart.querySelector('circle')?.getAttribute('cx')) };
    }, family);
    expect(bounds.labels.filter(label => label.left < 0 || label.right > bounds.width)).toEqual([]);
    expect(bounds.lastX).toBeGreaterThan(8);
    expect(bounds.lastX).toBeLessThan(bounds.width);
  }
  await expect(page.locator('svg')).toHaveAttribute('width', '120');
  await expect(page.locator('svg')).toContainText('LAST 1234567890123.4');
});
