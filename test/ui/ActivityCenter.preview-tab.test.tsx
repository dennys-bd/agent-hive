import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CenterLayout } from '@/lib/center-layout';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// The stage's run, then the spec's preview, shown (#697)
const PREVIEW: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'preview', path: 'docs/spec.md' }], active: 1 }, focused: 'g1' };

beforeEach(() => {
  resetCenterTest();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/file-version') ? jsonResponse({ version: 'v1' }) : jsonResponse({ path: 'docs/spec.md', text: '# Spec\n', version: 'v1' }))));
  seed(PREVIEW);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('a stored preview tab reads Preview and the file\'s name with its path as the tooltip, the header Preview and the path, and the file rendered (#697)', async () => {
  render(<Center runs={[STAGE]} />);
  expect(strips()).toEqual([['Claude', 'Preview spec.md']]);
  expect(screen.getByRole('tab', { name: 'Preview spec.md' })).toHaveAttribute('title', 'docs/spec.md');
  expect(document.querySelector('[data-pane-header]')).toHaveTextContent('Previewdocs/spec.md');
  expect(screen.getByRole('region', { name: '#1 Task 1 · Preview spec.md' })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { level: 1, name: 'Spec' })).toBeInTheDocument();
});
