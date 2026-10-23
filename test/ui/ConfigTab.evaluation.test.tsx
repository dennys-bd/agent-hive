import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, DRAFT_CONFIG, editIn, pills, region, renderConfig, rowIn, stubConfigFetch } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

async function pick(combobox: string, option: string): Promise<void> {
  const trigger = screen.getByRole('combobox', { name: combobox });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 }); // jsdom has no layout: a Radix Select trigger needs the pointer events to open
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

test("avaliação reads the collectors, the dynamic collector's scenarios and walks, the tester, the judge and the rubric's criteria (#463)", () => {
  renderConfig(CONFIG);
  expect(pills(rowIn('avaliação', 'coletores estáticos'))).toEqual(['code-reviewer', 'claude · sonnet']);
  expect(pills(rowIn('avaliação', 'coletor dinâmico'))).toEqual(['6 cenários S1–S6 · × 2 por cenário']);
  expect(pills(rowIn('avaliação', 'testador'))).toEqual(['claude · sonnet']);
  expect(pills(rowIn('avaliação', 'juiz'))).toEqual(['claude · opus']);
  expect(pills(rowIn('avaliação', 'rubrica'))).toEqual(['fidelidade', 'comportamento', 'código']);
});

test('with dynamic off the line reads desligado and the tester row is gone (#463)', () => {
  renderConfig({ ...CONFIG, evaluation: { ...CONFIG.evaluation, dynamic: false } });
  expect(pills(rowIn('avaliação', 'coletor dinâmico'))).toEqual(['desligado']);
  expect(within(region('avaliação')).queryByRole('group', { name: 'testador' })).not.toBeInTheDocument();
});

test("the form edits the collectors through #877's grid, the judge's picks, the walks and the rubric, and posts them; dynamic off hides the tester (#463)", async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('avaliação'));
  await user.click(screen.getByRole('button', { name: '+ coletor' }));
  await user.type(screen.getByRole('textbox', { name: 'foco do revisor 3' }), 'security');
  await user.click(screen.getByRole('button', { name: 'remover revisor 1' }));
  await pick('agente do juiz', 'codex');
  const walks = screen.getByRole('textbox', { name: 'passadas por cenário' });
  await user.clear(walks);
  await user.type(walks, '3');
  await user.type(screen.getByRole('textbox', { name: 'rubrica' }), '\nclareza');
  expect(screen.getByRole('combobox', { name: 'agente do testador' })).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'coletor dinâmico' }));
  expect(screen.queryByRole('combobox', { name: 'agente do testador' })).not.toBeInTheDocument();
  await user.click(within(region('avaliação')).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(calls).toEqual([{
    method: 'PATCH', path: '/benchmark/experiments/skills',
    body: { evaluation: {
      collectors: [{ agent: 'claude', model: 'sonnet', focus: 'tdd' }, { agent: 'claude', focus: 'security' }], dynamic: false,
      tester: { agent: 'claude', model: 'sonnet' }, scenarioWalks: 3, judge: { agent: 'codex' }, rubric: 'fidelidade\ncomportamento\n\ncódigo\nclareza',
    } },
  }]));
});

test('passadas below 1 keeps salvar off (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('avaliação'));
  await user.clear(screen.getByRole('textbox', { name: 'passadas por cenário' }));
  await user.type(screen.getByRole('textbox', { name: 'passadas por cenário' }), '0');
  expect(within(region('avaliação')).getByRole('button', { name: 'salvar' })).toBeDisabled();
});

test("editar cenários opens the seed section's form (#463)", async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(within(rowIn('avaliação', 'coletor dinâmico')).getByRole('button', { name: 'editar cenários' }));
  expect(screen.getByRole('textbox', { name: 'commit de partida' })).toBeInTheDocument();
});

test("julgar de novo sem executar confirms with the ended runs' count, then POSTs the evaluate route; disabled with none ended (#463)", async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  const { rerender } = renderConfig(CONFIG);
  await user.click(screen.getByRole('button', { name: 'julgar de novo sem executar' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Julgar de novo' });
  expect(dialog).toHaveTextContent('1 run encerrada');
  expect(dialog).toHaveTextContent('a avaliação de cada run encerrada é substituída por uma nova, dos mesmos diffs.');
  await user.click(within(dialog).getByRole('button', { name: 'julgar de novo' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/benchmark/experiments/skills/evaluate' }]));
  rerender({ ...DRAFT_CONFIG, id: CONFIG.id });
  expect(screen.getByRole('button', { name: 'julgar de novo sem executar' })).toBeDisabled();
});
