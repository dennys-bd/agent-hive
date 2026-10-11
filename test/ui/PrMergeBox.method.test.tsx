import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrMergeBox } from '@/components/PrMergeBox';
import { setLanguage } from '@/i18n';
import { fakePrHive, prData, STATE } from './pr-harness';

beforeEach(() => { setLanguage('pt'); localStorage.clear(); fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());

// Its own file: Radix's menus open reliably once per file under jsdom
test('the method picker lists only what the repository allows; the pick is remembered for the repository and names the button (#592, #758)', async () => {
  const user = userEvent.setup();
  render(<PrMergeBox pr={prData({ methods: ['merge', 'rebase'] })} state={STATE} onSettled={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'merge commit e merge' })).toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: 'método de merge' });
  trigger.focus();
  await user.keyboard('{Enter}');
  const items = await screen.findAllByRole('menuitemradio');
  expect(items.map((i) => i.textContent)).toEqual(['merge commit', 'rebase']);
  await user.click(items[1]);
  expect(JSON.parse(localStorage.getItem('hive.mergeMethod') ?? '{}')).toEqual({ 'acme/app': 'rebase' });
  expect(screen.getByRole('button', { name: 'rebase e merge' })).toBeInTheDocument();
});
