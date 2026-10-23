import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, editIn, pills, READINGS, region, renderConfig, rowIn, stubConfigFetch } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());
const field = (name: string): HTMLElement => screen.getByRole('textbox', { name });
const salvar = (): HTMLElement => within(region('ritmo')).getByRole('button', { name: 'salvar' });

test("ritmo reads the screen's rows; the cap's side is the spend now, the runs' tokens and the highest plan window rounded (#463)", () => {
  renderConfig(CONFIG, READINGS);
  expect(pills(rowIn('ritmo', 'pares'))).toEqual(['3']);
  expect(pills(rowIn('ritmo', 'não começar par novo depois de'))).toEqual(['07:00']);
  expect(pills(rowIn('ritmo', 'timeout por run'))).toEqual(['20h']);
  expect(pills(rowIn('ritmo', 'workers por braço'))).toEqual(['3']);
  expect(pills(rowIn('ritmo', 'teto de gasto'))).toEqual(['4M tokens', 'ou 40% do plano']);
  expect(rowIn('ritmo', 'teto de gasto')).toHaveTextContent('agora 1.5M · 40%');
});

test('no reading reads —; no limit reads sem limite; a cap with neither reads desligado; a plan cap alone drops the ou (#463)', () => {
  renderConfig({ ...CONFIG, pace: { ...CONFIG.pace, until: undefined, cap: {} } });
  expect(rowIn('ritmo', 'teto de gasto')).toHaveTextContent('agora 1.5M · —');
  expect(pills(rowIn('ritmo', 'não começar par novo depois de'))).toEqual(['sem limite']);
  expect(pills(rowIn('ritmo', 'teto de gasto'))).toEqual(['desligado']);
});

test('editar opens ritmo as a form; salvar sends one PATCH with pace alone and returns to the rows (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('ritmo'));
  await user.clear(field('pares'));
  await user.type(field('pares'), '5');
  fireEvent.change(screen.getByLabelText('não começar par novo depois de', { selector: 'input' }), { target: { value: '' } });
  await user.clear(field('horas de timeout por run'));
  await user.type(field('horas de timeout por run'), '1');
  await user.clear(field('minutos de timeout por run'));
  await user.type(field('minutos de timeout por run'), '30');
  await user.clear(field('tokens'));
  await user.clear(field('% do plano'));
  await user.click(salvar());
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/benchmark/experiments/skills', body: { pace: { pairs: 5, runTimeoutMs: 5_400_000, workersPerArm: 3, cap: {} } } }]));
  expect(within(region('ritmo')).getByRole('button', { name: 'editar' })).toBeInTheDocument();
});

test('cancelar drops the draft and posts nothing (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('ritmo'));
  await user.type(field('pares'), '9');
  await user.click(within(region('ritmo')).getByRole('button', { name: 'cancelar' }));
  expect(pills(rowIn('ritmo', 'pares'))).toEqual(['3']);
  expect(calls).toEqual([]);
});

test("the form mirrors the route's limits: the error under the field, salvar off while any is wrong (#463)", async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('ritmo'));
  await user.clear(field('pares'));
  await user.type(field('pares'), '0');
  await user.clear(field('% do plano'));
  await user.type(field('% do plano'), '120');
  expect(within(rowIn('ritmo', 'pares')).getByRole('alert')).toHaveTextContent('um número inteiro, 1 ou mais');
  expect(within(rowIn('ritmo', 'teto de gasto')).getByRole('alert')).toHaveTextContent('de 0 a 100');
  expect(salvar()).toBeDisabled();
});

test('an open form closes unsaved when the experiment starts running, and editar is gone (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  const { rerender } = renderConfig(CONFIG);
  await user.click(editIn('ritmo'));
  await user.type(field('pares'), '9');
  rerender({ ...CONFIG, status: 'running' });
  expect(screen.queryByRole('textbox', { name: 'pares' })).not.toBeInTheDocument();
  expect(within(region('ritmo')).queryByRole('button', { name: 'editar' })).not.toBeInTheDocument();
  rerender(CONFIG);
  expect(screen.queryByRole('textbox', { name: 'pares' })).not.toBeInTheDocument(); // closed for good, not hidden
  expect(calls).toEqual([]);
});
