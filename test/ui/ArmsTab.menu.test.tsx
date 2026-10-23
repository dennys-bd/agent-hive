import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ArmsTab } from '@/components/benchmark/arms/ArmsTab';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { arm } from '../benchmark/fixtures';
import { ARMS, ARMS_PATH, stubBenchmarkFetch } from './benchmark-fixtures';

type User = ReturnType<typeof userEvent.setup>;
function Tab({ experiment = ARMS }: { experiment?: Experiment }) {
  const benchmark = useBenchmark([experiment]);
  return <><ArmsTab experiment={experiment} benchmark={benchmark} /><output aria-label="aba">{benchmark.tab}</output><output aria-label="destaque">{benchmark.highlightedArm}</output></>;
}
const card = (letter: string): HTMLElement => screen.getByRole('region', { name: `braço ${letter}` });
// in jsdom a pointer click on a Radix trigger closes the menu again from the second test of a file on, so the trigger is focused and opened with Enter
async function openMenu(user: User, letter: string): Promise<void> {
  within(card(letter)).getByRole('button', { name: `ações do braço ${letter}` }).focus();
  await user.keyboard('{Enter}');
}
async function openAdd(user: User): Promise<void> {
  screen.getByRole('button', { name: /^\+ braço/ }).focus();
  await user.keyboard('{Enter}');
}
const item = (name: string | RegExp): Promise<HTMLElement> => screen.findByRole('menuitem', { name });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('copiar sobreposições para posts once with every checked arm, in arm order (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Tab />);
  await openMenu(user, 'A');
  (await item(/^copiar sobreposições para/)).focus();
  await user.keyboard('{ArrowRight}');
  const sub = await screen.findByRole('menu', { name: /copiar sobreposições para/ });
  fireEvent.click(within(sub).getByRole('menuitemcheckbox', { name: 'D · tarefas juntas' }));
  fireEvent.click(within(sub).getByRole('menuitemcheckbox', { name: 'B · skills do plugin' }));
  fireEvent.click(within(sub).getByRole('menuitem', { name: 'copiar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: `${ARMS_PATH}/arms/a1/copy`, body: { what: 'overrides', to: ['a2', 'a4'] } }]));
});

test('voltar tudo à base patches empty overrides, disabled with none; duplicar posts from the arm; ver em comparar selects compare with the arm highlighted (#462, #464)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Tab />);
  await openMenu(user, 'B');
  expect(await item('voltar tudo à base')).toHaveAttribute('data-disabled');
  await user.keyboard('{Escape}');
  await openMenu(user, 'C');
  await user.click(await item('voltar tudo à base'));
  await openMenu(user, 'C');
  await user.click(await item('duplicar como novo braço'));
  await openMenu(user, 'C');
  await user.click(await item('ver em comparar'));
  await waitFor(() => expect(calls).toEqual([
    { method: 'PATCH', path: `${ARMS_PATH}/arms/a3`, body: { overrides: {} } },
    { method: 'POST', path: `${ARMS_PATH}/arms`, body: { from: 'a3' } },
  ]));
  expect(screen.getByLabelText('aba')).toHaveTextContent('compare');
  expect(screen.getByLabelText('destaque')).toHaveTextContent('a3');
});

test('renomear turns the name into a field: a blank name stays refused in place, Enter posts the trimmed new one (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Tab />);
  await openMenu(user, 'A');
  await user.click(await item('renomear'));
  const field = await screen.findByRole('textbox', { name: 'nome do braço A' });
  await user.clear(field);
  await user.keyboard('{Enter}');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(calls).toEqual([]);
  await user.type(field, '  novo nome {Enter}');
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a1`, body: { name: 'novo nome' } }]));
  expect(screen.queryByRole('textbox', { name: 'nome do braço A' })).not.toBeInTheDocument();
});

test('remover braço confirms naming the arm, then deletes; disabled on the last arm (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const { unmount } = render(<Tab />);
  await openMenu(user, 'D');
  await user.click(await item('remover braço'));
  const dialog = await screen.findByRole('alertdialog', { name: 'Remover braço' });
  expect(dialog).toHaveTextContent('D · tarefas juntas');
  await user.click(within(dialog).getByRole('button', { name: 'remover' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: `${ARMS_PATH}/arms/a4` }]));
  unmount();
  render(<Tab experiment={{ ...ARMS, arms: [ARMS.arms[0]] }} />);
  await openMenu(user, 'A');
  expect(await item('remover braço')).toHaveAttribute('data-disabled');
});

test('+ braço offers da base then each arm; a pick posts its from (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Tab />);
  await openAdd(user);
  await user.click(await item('da base'));
  await openAdd(user);
  await user.click(await item('C · plugin + codex'));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: `${ARMS_PATH}/arms`, body: { from: 'base' } }, { method: 'POST', path: `${ARMS_PATH}/arms`, body: { from: 'a3' } }]));
});

test('locked or full: + braço is disabled; a running experiment keeps only ver em comparar in the menu (#462)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch();
  const full = { ...ARMS, arms: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l, i) => arm(`a${i}`, l)) };
  const { unmount } = render(<Tab experiment={full} />);
  expect(screen.getByRole('button', { name: /^\+ braço/ })).toBeDisabled();
  unmount();
  render(<Tab experiment={{ ...ARMS, status: 'running' }} />);
  expect(screen.getByRole('button', { name: /^\+ braço/ })).toBeDisabled();
  await openMenu(user, 'C');
  for (const name of ['duplicar como novo braço', 'voltar tudo à base', 'renomear', 'remover braço']) expect(await item(name)).toHaveAttribute('data-disabled');
  expect(await item(/^copiar tarefas para/)).toHaveAttribute('data-disabled');
  expect(await item('ver em comparar')).not.toHaveAttribute('data-disabled');
});
