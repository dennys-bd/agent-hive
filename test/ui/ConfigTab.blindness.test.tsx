import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, editIn, pills, region, renderConfig, rowIn, stubConfigFetch } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());
const PATH = '/benchmark/experiments/skills';

test("cegueira reads the baseline's removed paths, the neutral branch and the forbidden words; the switch PATCHes blindness with on flipped (#463)", async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  expect(pills(rowIn('cegueira', 'arquivos do benchmark'))).toEqual(['scripts/experiment', 'test/experiment']);
  expect(pills(rowIn('cegueira', 'nomes de branch'))).toEqual(['work/<token>', 'em vez de …/a/…']);
  expect(pills(rowIn('cegueira', 'palavras proibidas'))).toEqual(['benchmark', 'braço', 'experimento']);
  expect(within(region('cegueira')).getByText('ligada')).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'cegueira' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: PATH, body: { blindness: { on: false, forbiddenWords: ['benchmark', 'braço', 'experimento'] } } }]));
});

test('with blindness off the three rows sit at .55 and the switch reads desligada (#463)', () => {
  renderConfig({ ...CONFIG, blindness: { ...CONFIG.blindness, on: false } });
  expect(rowIn('cegueira', 'nomes de branch').parentElement).toHaveClass('opacity-55');
  expect(within(region('cegueira')).getByText('desligada')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'cegueira' })).not.toBeChecked();
});

test('editar opens the word list, one per line; salvar drops the blanks and keeps on (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('cegueira'));
  const words = screen.getByRole('textbox', { name: 'palavras proibidas' });
  expect(words).toHaveValue('benchmark\nbraço\nexperimento');
  await user.type(words, '\n\n bench ');
  await user.click(within(region('cegueira')).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: PATH, body: { blindness: { on: true, forbiddenWords: ['benchmark', 'braço', 'experimento', 'bench'] } } }]));
});
