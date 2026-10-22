import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, DRAFT_CONFIG, editIn, pills, region, renderConfig, rowIn, stubConfigFetch } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());
const commit = (): HTMLElement => screen.getByRole('textbox', { name: 'commit de partida' });
const SHA = 'b'.repeat(40);

test("seed reads the screen's rows: the hash, the workspace read-only in its colour, the commit, the entries, the sample, the scenarios (#463)", () => {
  renderConfig(CONFIG);
  expect(within(region('seed')).getByText('hash 7e21b0')).toBeInTheDocument();
  expect(within(region('seed')).getByText(/mudar qualquer linha do seed gera um hash novo/)).toBeInTheDocument();
  const workspace = rowIn('seed', 'workspace');
  expect(pills(workspace)).toEqual(['agent-hive']);
  expect(workspace).toHaveTextContent('um por experimento');
  expect(within(workspace).queryByRole('button')).not.toBeInTheDocument();
  expect(workspace.querySelector('span[style]')).toHaveStyle({ backgroundColor: '#7c8cff' });
  expect(pills(rowIn('seed', 'commit de partida'))).toEqual(['4c1e9a2', 'origin local']);
  expect(within(rowIn('seed', 'commit de partida')).getByRole('button', { name: 'trocar' })).toBeInTheDocument();
  expect(pills(rowIn('seed', 'referência'))).toEqual(['handoff_plugins', 'spec.md', 'print-1.png']);
  expect(pills(rowIn('seed', 'dados de exemplo'))).toEqual(['fixtures/bench-seed.sql', 'pnpm dev', 'localhost:5173']);
  expect(pills(rowIn('seed', 'cenários'))).toEqual(['6 cenários S1–S6']);
});

test('a seed save on an experiment with rounds shows the fork notice and salvar como novo, then selects the fork the route answers (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch({ 'PATCH /benchmark/experiments/skills': { body: { id: 'skills-fork' } } });
  const { select } = renderConfig(CONFIG);
  await user.click(within(rowIn('seed', 'commit de partida')).getByRole('button', { name: 'trocar' }));
  expect(within(region('seed')).getByText('salvar cria um experimento novo; as rodadas ficam neste')).toBeInTheDocument();
  await user.clear(commit());
  await user.type(commit(), SHA);
  await user.click(screen.getByRole('button', { name: '+ cenário' }));
  await user.type(screen.getByRole('textbox', { name: 'título do cenário 7' }), 'exporta');
  await user.click(within(region('seed')).getByRole('button', { name: 'salvar como novo' }));
  await waitFor(() => expect(select).toHaveBeenCalledWith('skills-fork'));
  expect(calls).toEqual([{
    method: 'PATCH', path: '/benchmark/experiments/skills',
    body: { seed: { ...CONFIG.seed, commit: SHA, scenarios: [...CONFIG.seed.scenarios, { id: 'S7', title: 'exporta', text: '' }] } },
  }]);
});

test('on a draft there is no notice, the button reads salvar, and the same id answered selects nothing (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  const { select } = renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  expect(within(region('seed')).queryByText(/salvar cria um experimento novo/)).not.toBeInTheDocument();
  await user.click(within(region('seed')).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(select).not.toHaveBeenCalled();
});

test("a commit outside the route's sha, or a repeated or blank scenario id, keeps salvar off with the error under the field (#463)", async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  await user.clear(commit());
  await user.type(commit(), 'main');
  expect(within(rowIn('seed', 'commit de partida')).getByRole('alert')).toHaveTextContent('um sha de commit: de 7 a 64 caracteres hex');
  await user.clear(commit());
  await user.type(commit(), SHA);
  const id2 = screen.getByRole('textbox', { name: 'id do cenário 2' });
  await user.clear(id2);
  await user.type(id2, 'S1');
  expect(within(rowIn('seed', 'cenários')).getByRole('alert')).toHaveTextContent('cada cenário precisa de um id próprio');
  expect(within(region('seed')).getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'remover cenário 2' }));
  expect(within(region('seed')).getByRole('button', { name: 'salvar' })).toBeEnabled();
});

test('opening another section over unsaved changes asks to discard; descartar opens it, and nothing is posted (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('seed'));
  await user.type(commit(), 'f');
  await user.click(editIn('ritmo'));
  const dialog = await screen.findByRole('alertdialog', { name: 'Descartar alterações' });
  await user.click(within(dialog).getByRole('button', { name: 'descartar' }));
  expect(screen.queryByRole('textbox', { name: 'commit de partida' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'pares' })).toBeInTheDocument();
  expect(calls).toEqual([]);
});

test('with no change, another editar just switches sections, no question asked (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('seed'));
  await user.click(editIn('ritmo'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'pares' })).toBeInTheDocument();
});

test('+ caminho adds a repository path without its trailing slash; a path with .. is refused; × removes an entry (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  const reference = rowIn('seed', 'referência');
  await user.click(within(reference).getByRole('button', { name: '+ caminho' }));
  await user.type(screen.getByRole('textbox', { name: 'novo caminho em referência' }), '../x');
  expect(within(reference).getByRole('alert')).toHaveTextContent('um caminho dentro do repositório, sem ..');
  await user.clear(screen.getByRole('textbox', { name: 'novo caminho em referência' }));
  await user.type(screen.getByRole('textbox', { name: 'novo caminho em referência' }), 'docs/handoff/{Enter}');
  await user.click(within(reference).getByRole('button', { name: 'remover spec.md' }));
  expect(pills(reference)).toEqual(['handoff_plugins', 'print-1.png', 'docs/handoff']);
});
