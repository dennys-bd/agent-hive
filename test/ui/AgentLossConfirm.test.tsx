import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { LiveRun } from '../../src/task-runs';
import type { Task } from '../../src/types';
import { useConfirmLoss } from '@/components/AgentLossConfirm';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import { localPairOf, taskPairOf } from '../fixtures/work';

const TASK: Task = { item: { itemId: 'I480', id: '480', title: 'A hung daemon is taken for a stale one', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const SHELL: LiveRun = { ptyId: 'W3', label: 'Terminal 2', kind: 'terminal' };
const OF_TASK: Activity = { kind: 'task', ...taskPairOf('I480'), task: TASK, runs: [SHELL], sessions: [], status: 'empty', worker: false };
const OF_LOCAL: Activity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [SHELL], sessions: [], kept: [] };

function Asker({ activity, sleep }: { activity: Activity; sleep(): void }) {
  const loss = useConfirmLoss(activity);
  return <><button type="button" onClick={() => loss.confirm(sleep, 'W3')}>pedir</button>{loss.dialog}</>;
}

beforeEach(() => setLanguage('pt'));

test('the sleep confirm reads Dormir sessão, its context the terminal and its task in mono, the lowercase message; dormir sleeps and closes (#75)', async () => {
  const user = userEvent.setup();
  const sleep = vi.fn();
  render(<Asker activity={OF_TASK} sleep={sleep} />);
  await user.click(screen.getByRole('button', { name: 'pedir' }));
  const dialog = screen.getByRole('alertdialog', { name: 'Dormir sessão' });
  expect(within(dialog).getByText('Terminal 2 · #480 A hung daemon is taken for a stale one')).toHaveClass('font-mono');
  expect(dialog).toHaveTextContent('um agente que o Hive não capturou executa num terminal: a conversa dele se perde quando o terminal dorme.');
  await user.click(within(dialog).getByRole('button', { name: 'dormir' }));
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('a local activity\'s terminal shows its label alone (#75)', async () => {
  const user = userEvent.setup();
  render(<Asker activity={OF_LOCAL} sleep={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'pedir' }));
  expect(within(screen.getByRole('alertdialog')).getByText('Terminal 2')).toHaveClass('font-mono');
});
