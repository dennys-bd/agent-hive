import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, editIn, region, renderConfig, stubConfigFetch } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('while the experiment runs or sleeps the locked note sits on top; a done one has none (#463)', () => {
  const { rerender } = renderConfig({ ...CONFIG, status: 'running' });
  expect(screen.getByText('a config trava enquanto o experimento executa')).toBeInTheDocument();
  rerender({ ...CONFIG, status: 'sleeping' });
  expect(screen.getByText('a config trava enquanto o experimento executa')).toBeInTheDocument();
  rerender(CONFIG);
  expect(screen.queryByText('a config trava enquanto o experimento executa')).not.toBeInTheDocument();
});

test('while running no editar, trocar or editar cenários is drawn in any section, the switch and julgar de novo are off, the rows still read (#463)', () => {
  renderConfig({ ...CONFIG, status: 'running' });
  expect(screen.queryAllByRole('button', { name: /^(editar|trocar)/ })).toEqual([]);
  expect(screen.getByRole('switch', { name: 'cegueira' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'julgar de novo sem executar' })).toBeDisabled();
  expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['seed', 'ritmo', 'isolamento', 'cegueira', 'avaliação']);
});

test('every row in a card draws its own top divider but the first, and nothing resets it (#537)', () => {
  renderConfig(CONFIG);
  for (const name of ['seed', 'ritmo', 'isolamento', 'cegueira', 'avaliação']) {
    const rows = within(region(name)).getAllByRole('group');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row).toHaveClass('border-t', 'first:border-t-0'); // jsdom has no layout: the class is what can be checked
      expect(row).not.toHaveClass('border-0');
    }
  }
});

const SECTIONS = ['seed', 'ritmo', 'isolamento', 'cegueira', 'avaliação'];
const header = (name: string): HTMLElement => region(name).firstElementChild as HTMLElement;

test('each section has one editar, last in its header, and none in its rows; trocar is gone (#537)', () => {
  renderConfig(CONFIG);
  for (const name of SECTIONS) {
    expect(header(name).lastElementChild).toBe(within(header(name)).getByRole('button', { name: `editar ${name}` }));
    for (const row of within(region(name)).getAllByRole('group')) expect(within(row).queryByRole('button', { name: /^(editar|trocar)$/ })).toBeNull();
  }
});

test("an open section's header keeps editar's place unseen; the other sections keep theirs (#537)", async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('ritmo'));
  expect(within(header('ritmo')).queryByRole('button', { name: 'editar ritmo' })).toBeNull();
  expect(header('ritmo').lastElementChild).toHaveClass('invisible');
  expect(header('ritmo').lastElementChild).toHaveTextContent('editar');
  expect(editIn('seed')).toBeInTheDocument();
});
