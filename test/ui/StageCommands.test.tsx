import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { StageCommands } from '@/components/settings/StageCommands';
import { setLanguage } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-form';
import type { Command, OnMissing } from '../../src/types';

beforeEach(() => setLanguage('pt'));

const OPTIONS: Command[] = [
  { name: 'build', impls: [{ workspace: null, command: 'pnpm build' }], menu: false, env: {} },
  { name: 'tests', impls: [{ workspace: 'site', command: 'pytest' }, { workspace: null, command: 'pnpm run tests' }], menu: true, env: {} },
  { name: 'e2e', impls: [{ workspace: 'hive', command: 'pnpm e2e' }], menu: true, env: {} },
];

// The block over its own draft, as StageEditor holds it: every update is seen and applied
function Harness({ initial, onMissing = 'fail', onUpdate }: { initial: string[]; onMissing?: OnMissing; onUpdate(patch: Partial<StageDraft>): void }) {
  const [stage, setStage] = useState<StageDraft>({ ...emptyStage(), action: 'commands', commands: initial, onMissing });
  return <StageCommands id="s" stage={stage} options={OPTIONS} workspaces={['hive', 'site']} onUpdate={(patch) => { onUpdate(patch); setStage((s) => ({ ...s, ...patch })); }} />;
}
const rows = (): string[] => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');

test('each row shows its place, its name and, under it, the line each workspace runs; + comando offers every command not listed, stages-only ones too; x removes one (#755)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness initial={['tests']} onUpdate={onUpdate} />);
  expect(rows()).toEqual(['1testspnpm run testspytest']);
  screen.getByRole('button', { name: '+ comando' }).focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['build', 'e2e']);
  await user.click(screen.getByRole('menuitem', { name: 'e2e' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ commands: ['tests', 'e2e'] });
  expect(rows()).toEqual(['1testspnpm run testspytest', '2e2epnpm e2enão existe em site · falha']);
  await user.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'remover comando tests' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ commands: ['e2e'] });
});

test('dragging a row onto another moves it there (#755)', () => {
  const onUpdate = vi.fn();
  render(<Harness initial={['build', 'tests', 'e2e']} onUpdate={onUpdate} />);
  const [first, , last] = screen.getAllByRole('listitem');
  fireEvent.dragStart(last);
  fireEvent.dragOver(first);
  fireEvent.drop(first);
  expect(onUpdate).toHaveBeenLastCalledWith({ commands: ['e2e', 'build', 'tests'] });
});

test('a focused row moves with Alt+↑ and Alt+↓, so the order is reachable without a mouse (#755)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness initial={['build', 'tests', 'e2e']} onUpdate={onUpdate} />);
  const [first] = screen.getAllByRole('listitem');
  expect(first).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
  first.focus();
  await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
  expect(onUpdate).toHaveBeenLastCalledWith({ commands: ['tests', 'build', 'e2e'] });
  await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(onUpdate).toHaveBeenLastCalledWith({ commands: ['build', 'tests', 'e2e'] });
  onUpdate.mockClear();
  await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(onUpdate).not.toHaveBeenCalled();
});

test('a workspace with no line reads não existe em {ws} · falha in destructive under fail and · pula muted under skip; a name the Comb lost fails in every workspace (#755)', () => {
  const { unmount } = render(<Harness initial={['e2e', 'gone']} onUpdate={vi.fn()} />);
  const [e2e, gone] = screen.getAllByRole('listitem');
  expect(within(e2e).getByText('pnpm e2e')).toHaveClass('text-muted-foreground');
  expect(within(e2e).getByText('não existe em site · falha')).toHaveClass('text-destructive');
  expect(within(gone).getByText('não existe em hive · falha')).toHaveClass('text-destructive');
  expect(within(gone).getByText('não existe em site · falha')).toBeInTheDocument();
  unmount();
  render(<Harness initial={['e2e', 'gone']} onMissing="skip" onUpdate={vi.fn()} />);
  const [skipped, lost] = screen.getAllByRole('listitem');
  expect(within(skipped).getByText('não existe em site · pula')).toHaveClass('text-muted-foreground');
  expect(within(lost).getByText('não existe em hive · falha')).toHaveClass('text-destructive');
});

test('parar no primeiro que falhar is a switch, on for a new commands stage, with its hint, the list\'s note and the verdict note (#755)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness initial={[]} onUpdate={onUpdate} />);
  const toggle = screen.getByRole('switch', { name: 'parar no primeiro que falhar' });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(onUpdate).toHaveBeenLastCalledWith({ stopOnFailure: false });
  expect(screen.getByText('senão executa todos e junta as saídas')).toBeInTheDocument();
  expect(screen.getByText('os comandos de workspaces › comandos, na ordem, na worktree · cada workspace executa o seu')).toBeInTheDocument();
  expect(screen.getByText('veredito pelo código de saída: todos 0 = "passou" · a saída de quem falhou entra em {result.commands.output}')).toBeInTheDocument();
});

test('se o workspace não tiver um comando is a select under the switch, falhar a etapa for a new stage, with its hint per option (#755)', async () => {
  const onUpdate = vi.fn();
  render(<Harness initial={['build']} onUpdate={onUpdate} />);
  const select = screen.getByRole('combobox', { name: 'se o workspace não tiver um comando' });
  expect(select).toHaveTextContent('falhar a etapa');
  expect(screen.getByText('falha antes de executar qualquer comando, com "{comando} não existe em {workspace}" · a outra opção é pular o comando')).toBeInTheDocument();
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole('option', { name: 'pular o comando' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ onMissing: 'skip' });
  expect(screen.getByText('executa os que existem e registra "pulado · não existe em {workspace}" na tarefa · se nenhum existir, a etapa passa')).toBeInTheDocument();
});
