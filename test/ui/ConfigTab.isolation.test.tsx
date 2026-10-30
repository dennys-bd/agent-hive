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

const ENV_ERROR = 'cada variável é NOME=valor; o nome tem letras, dígitos e _';

test('the draft holds the lists as chips and round-trips, per-arm rows included; limits read as typed; the errors name the bad rows (#463, #537)', () => {
  const iso = { ...CONFIG.isolation, network: { all: ['github.com'], perArm: { a1: ['github.com', 'pypi.org'] } }, env: { all: { CI: '1' }, perArm: { a2: { CI: '1', X: 'y' } } } };
  const draft = isolationDraft(iso);
  expect(isolationFrom(draft, iso)).toEqual(iso);
  expect(isolationFrom(isolationDraft(CONFIG.isolation), CONFIG.isolation)).toEqual(CONFIG.isolation);
  expect([draft.network, draft.env]).toEqual([iso.network, { all: ['CI=1'], perArm: { a2: ['CI=1', 'X=y'] } }]);
  expect(draft.limits.all).toEqual({ turns: '200', time: { hours: '2', minutes: '0' } });
  expect(isolationErrors({ ...draft, env: { all: ['CI=1'], perArm: { a1: ['9X=1'] } }, limits: { all: { turns: '0', time: { hours: '', minutes: '' } } } }))
    .toEqual({ env: 'benchmark.config.error.env', limits: 'benchmark.config.error.limits' });
  expect(isolationFrom({ ...draft, limits: { all: { turns: '', time: { hours: '', minutes: '' } } } }, iso).limits).toEqual({ all: {} });
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

test('the scope menu gives every arm its own chips and back; back drops perArm, so salvar sends the isolation as it was (#463, #537)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  await openScope(user, 'escopo de rede');
  await user.click(await screen.findByRole('menuitem', { name: 'varia por braço' }));
  expect(within(rowIn('isolamento', 'rede')).getAllByRole('button', { name: 'tirar github.com' })).toHaveLength(4);
  await user.type(screen.getByRole('textbox', { name: 'adicionar host · A' }), 'pypi.org{Enter}');
  expect(within(rowIn('isolamento', 'rede')).getAllByRole('button', { name: 'tirar pypi.org' })).toHaveLength(1);
  await openScope(user, 'escopo de rede');
  await user.click(await screen.findByRole('menuitem', { name: 'todos os braços' }));
  expect(screen.queryByRole('textbox', { name: 'adicionar host · A' })).not.toBeInTheDocument();
  await user.click(salvar());
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/benchmark/experiments/skills', body: { isolation: CONFIG.isolation } }]));
});

test('the warning is live in the form: a deny chip for every arm clears it (#463, #537)', async () => {
  const user = userEvent.setup();
  stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  expect(region('isolamento')).toHaveTextContent(WARNING);
  await user.type(screen.getByRole('textbox', { name: 'adicionar regra negada' }), 'WebFetch{Enter}');
  expect(region('isolamento')).not.toHaveTextContent(WARNING);
});

test('removing and adding a tool chip posts the list (#537)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  await user.click(screen.getByRole('button', { name: 'tirar Read' }));
  await user.type(screen.getByRole('textbox', { name: 'adicionar regra permitida' }), 'Grep{Enter}');
  await user.click(salvar());
  await waitFor(() => expect(calls).toEqual([{
    method: 'PATCH', path: '/benchmark/experiments/skills', body: { isolation: { ...CONFIG.isolation, allowedTools: { all: ['Edit', 'Bash(npm test:*)', 'Grep'] } } },
  }]));
});

test("permissões picks a mode per arm; a bad env chip shows the row's error and keeps salvar off; the PATCH carries isolation alone (#463, #537)", async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(CONFIG);
  await user.click(editIn('isolamento'));
  const trigger = screen.getByRole('combobox', { name: 'permissões · A' });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 }); // jsdom has no layout: a Radix Select trigger needs the pointer events to open
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name: 'plan' }));
  await user.type(screen.getByRole('textbox', { name: 'adicionar variável' }), '1BAD=x{Enter}');
  expect(within(rowIn('isolamento', 'variáveis de ambiente')).getByRole('alert')).toHaveTextContent(ENV_ERROR);
  expect(salvar()).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'tirar 1BAD=x' }));
  await user.click(screen.getByRole('button', { name: 'tirar HIVE_BENCH=1' }));
  await user.click(salvar());
  await waitFor(() => expect(calls).toEqual([{
    method: 'PATCH', path: '/benchmark/experiments/skills',
    body: { isolation: { ...CONFIG.isolation, permissionMode: { all: 'dontAsk', perArm: { ...CONFIG.isolation.permissionMode.perArm, a1: 'plan' } }, env: { all: { CI: '1' } } } },
  }]));
});

const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm test:*)', 'Bash(git commit:*)', 'Bash(git add:*)', 'Bash(git status)', 'Bash(git diff:*)', 'Bash(pnpm lint)', 'TodoWrite'];

test('12 allowed tools read 7 pills and mais 5; mais shows all 12 and turns into menos (#537)', async () => {
  const user = userEvent.setup();
  renderConfig({ ...CONFIG, isolation: { ...CONFIG.isolation, allowedTools: { all: TOOLS } } });
  const row = rowIn('isolamento', 'ferramentas permitidas');
  expect(pills(row)).toEqual(TOOLS.slice(0, 7));
  await user.click(within(row).getByRole('button', { name: 'mais 5' }));
  expect(pills(row)).toEqual(TOOLS);
  expect(within(row).getByRole('button', { name: 'menos' })).toHaveAttribute('aria-expanded', 'true');
});
