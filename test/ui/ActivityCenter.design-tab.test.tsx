import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CenterLayout } from '@/lib/center-layout';
import { jsonResponse } from '../fakes';
import { REVIEW } from './design-review';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// The stage's run, then a Hive design, shown (#109)
const DESIGN: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'design', path: 'design/Landing.hv.html' }], active: 1 }, focused: 'g1' };

beforeEach(() => {
  resetCenterTest();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/Landing.hv.html' }) : jsonResponse({ version: 'v1' }))));
  seed(DESIGN);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('a stored design tab reads its file\'s name with its path as the tooltip, has no pane header, and renders the minted frame (#109)', async () => {
  render(<Center runs={[STAGE]} />);
  expect(strips()).toEqual([['Claude', 'Landing.hv.html']]);
  expect(screen.getByRole('tab', { name: 'Landing.hv.html' })).toHaveAttribute('title', 'design/Landing.hv.html');
  expect(document.querySelector('[data-pane-header]')).toBeNull();
  expect(screen.getByRole('region', { name: '#1 Task 1 · Design Landing.hv.html' })).toBeInTheDocument();
  expect(await screen.findByTitle('Landing.hv.html')).toHaveAttribute('src', '/design-frame/tok/Landing.hv.html');
});

test('the design tab shows its open count in a pill before its ×, beside the tab\'s name (#113)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/tasks/I1/review') return jsonResponse(REVIEW);
    return url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/Landing.hv.html' }) : jsonResponse({ version: 'v1' });
  }));
  render(<Center runs={[STAGE]} />);
  const tab = document.querySelector<HTMLElement>('[data-tab-key="design:design/Landing.hv.html"]');
  expect(await within(tab as HTMLElement).findByText('4')).toHaveClass('bg-accent');
  expect(strips()).toEqual([['Claude', 'Landing.hv.html']]); // the pill sits outside the tab\'s name
});
