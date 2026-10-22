import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isolationDraft, isolationErrors, isolationFrom } from '@/components/benchmark/config/isolation-draft';
import { setLanguage } from '@/i18n';
import { CONFIG, editIn, pills, region, renderConfig, rowIn, stubConfigFetch } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());
const salvar = (): HTMLElement => within(region('isolamento')).getByRole('button', { name: 'salvar' });
// Radix opens a DropdownMenu on pointerdown, which jsdom does not deliver as a PointerEvent; the keyboard path opens the same menu
const openScope = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => {
  screen.getByRole('button', { name }).focus();
  await user.keyboard('{Enter}');
};
const WARNING = 'C sem pergunta e sem regra de negação';

test('the draft round-trips; limits and env read as typed; the errors name the bad rows (#463)', () => {
  const draft = isolationDraft(CONFIG.isolation);
  expect(isolationFrom(draft, CONFIG.isolation)).toEqual(CONFIG.isolation);
  expect([draft.env.all, draft.limits.all]).toEqual(['CI=1\nHIVE_BENCH=1', { turns: '200', time: { hours: '2', minutes: '0' } }]);
  expect(isolationErrors({ ...draft, env: { all: 'CI=1', perArm: { a1: '9X=1' } }, limits: { all: { turns: '0', time: { hours: '', minutes: '' } } } }))
    .toEqual({ env: 'benchmark.config.error.env', limits: 'benchmark.config.error.limits' });
  expect(isolationFrom({ ...draft, limits: { all: { turns: '', time: { hours: '', minutes: '' } } } }, CONFIG.isolation).limits).toEqual({ all: {} });
});

test("isolamento reads one row per key in the screen's order; permissões varies, one pill per arm, C's yellow with the warning naming C (#463)", () => {
  renderConfig(CONFIG);
  expect(within(region('isolamento')).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
    'ambiente', 'rede', 'permissões', 'ferramentas permitidas', 'ferramentas negadas', 'limite por tarefa', 'variáveis de ambiente', 'entre rodadas',
  ]);
  const modes = rowIn('isolamento', 'permissões');
  expect(pills(modes)).toEqual(['AdontAsk', 'BdontAsk', 'CbypassPermissions', 'DdontAsk']);
  expect([...modes.querySelectorAll('[data-slot="badge"].border-waiting')].map((b) => b.textContent)).toEqual(['CbypassPermissions']);
  expect(modes).toHaveTextContent(WARNING);
  expect(modes).toHaveTextContent('varia por braço');
  expect(rowIn('isolamento', 'rede')).toHaveTextContent('todos os braços');
  expect(pills(rowIn('isolamento', 'ambiente'))).toEqual(['local']);
  expect(rowIn('isolamento', 'ambiente')).not.toHaveTextContent('todos os braços'); // one value allowed: no scope
  expect(pills(rowIn('isolamento', 'limite por tarefa'))).toEqual(['200 turnos', '2h']);
  expect(pills(rowIn('isolamento', 'variáveis de ambiente'))).toEqual(['CI=1', 'HIVE_BENCH=1']);
  expect(pills(rowIn('isolamento', 'entre rodadas'))).toEqual(['worktree nova']);
  expect(within(rowIn('isolamento', 'ferramentas negadas')).getByText('nenhum')).toBeInTheDocument();
});

test('the scope menu turns rede into one field per arm and back; back drops perArm, so salvar sends the isolation as it was (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  await openScope(user, 'escopo de rede');
  await user.click(await screen.findByRole('menuitem', { name: 'varia por braço' }));
  expect(['A', 'B', 'C', 'D'].map((l) => (screen.getByRole('textbox', { name: `rede · ${l}` }) as HTMLTextAreaElement).value)).toEqual(Array(4).fill('registry.npmjs.org\ngithub.com'));
  await user.type(screen.getByRole('textbox', { name: 'rede · A' }), '\npypi.org');
  await openScope(user, 'escopo de rede');
  await user.click(await screen.findByRole('menuitem', { name: 'todos os braços' }));
  expect(screen.queryByRole('textbox', { name: 'rede · A' })).not.toBeInTheDocument();
  await user.click(salvar());
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/benchmark/experiments/skills', body: { isolation: CONFIG.isolation } }]));
});

test('the warning is live in the form: a deny rule for every arm clears it (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  expect(region('isolamento')).toHaveTextContent(WARNING);
  await user.type(screen.getByRole('textbox', { name: 'ferramentas negadas' }), 'WebFetch');
  expect(region('isolamento')).not.toHaveTextContent(WARNING);
});

test("permissões picks a mode per arm; a bad env name keeps salvar off; the PATCH carries isolation alone (#463)", async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  const trigger = screen.getByRole('combobox', { name: 'permissões · A' });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 }); // jsdom has no layout: a Radix Select trigger needs the pointer events to open
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name: 'plan' }));
  const env = screen.getByRole('textbox', { name: 'variáveis de ambiente' });
  await user.type(env, '\n1BAD=x');
  expect(within(rowIn('isolamento', 'variáveis de ambiente')).getByRole('alert')).toHaveTextContent('um NOME=valor por linha; o nome tem letras, dígitos e _');
  expect(salvar()).toBeDisabled();
  await user.clear(env);
  await user.type(env, 'CI=1');
  await user.click(salvar());
  await waitFor(() => expect(calls).toEqual([{
    method: 'PATCH', path: '/benchmark/experiments/skills',
    body: { isolation: { ...CONFIG.isolation, permissionMode: { all: 'dontAsk', perArm: { ...CONFIG.isolation.permissionMode.perArm, a1: 'plan' } }, env: { all: { CI: '1' } } } },
  }]));
});
