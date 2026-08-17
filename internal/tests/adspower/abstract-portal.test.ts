import type { Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import {
  clickLastVisibleControl,
  clickVisibleControlMatching,
} from '../../src/adspower/abstract-portal.js';

function controlPage(labels: readonly string[]): {
  page: Page;
  clicks: ReturnType<typeof vi.fn>[];
} {
  const clicks = labels.map(() => vi.fn(async () => undefined));
  const handles = labels.map((_, index) => ({
    click: clicks[index],
    dispose: vi.fn(async () => undefined),
  }));
  return {
    page: {
      evaluate: vi.fn(async () => labels.map((text, index) => ({ index, text }))),
      $$: vi.fn(async () => handles),
    } as unknown as Page,
    clicks,
  };
}

describe('AdsPower first-party controls', () => {
  it('clicks the modal confirmation instead of the covered inventory button', async () => {
    const { page, clicks } = controlPage(['OPEN', 'OPEN']);

    await expect(clickLastVisibleControl(page, ['Open'])).resolves.toBe('OPEN');
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it('recognizes a dynamic Tollan Batch Open label', async () => {
    const { page, clicks } = controlPage(['OPEN', 'BATCH OPEN (12)']);

    await expect(clickVisibleControlMatching(page, /^batch\s+open\s*\(\d+\)$/i)).resolves.toBe(
      'BATCH OPEN (12)',
    );
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });
});
