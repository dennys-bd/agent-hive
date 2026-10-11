import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import type { Checkpoint } from '../../src/types';
import { activityOf, callsTo, fakeHive, type FakeHive, LABEL, renderPane } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const pane = (): HTMLElement => screen.getByRole('region', { name: LABEL });
const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'barra do diff' });
const checkpoint = (n: number, stage: string): Checkpoint => ({ n, stage, start: 'a'.repeat(40), head: 'a'.repeat(40), commit: 'b'.repeat(40), branch: 'x', at: '2026-10-10T10:00:00.000Z', ended: 'done' });
const withCheckpoints = (): TaskActivity => {
  const base = activityOf();
  return { ...base, activity: { ...base.activity, checkpoints: [checkpoint(1, 'spec'), checkpoint(2, 'dev')] } } as TaskActivity;
};

test('the checkpoint scope fetches the latest checkpoint when the tab names none; its picker lists latest first and hands a pick to onScope (#619)', async () => {
  const user = userEvent.setup();
  const { onScope } = renderPane(withCheckpoints(), 'checkpoint');
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  expect(callsTo(hive, 'GET', '/activities/a-I1/diff?scope=checkpoint&checkpoint=2')).toHaveLength(1);
  const picker = within(bar()).getByRole('button', { name: 'ponto de restauração do diff' });
  expect(picker).toHaveTextContent('dev · 2');
  picker.focus();
  await user.keyboard('{Enter}');
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['dev · 2', 'spec · 1']);
  await user.click(screen.getByRole('menuitem', { name: 'spec · 1' }));
  expect(onScope).toHaveBeenCalledWith('checkpoint', 1);
});

test('the checkpoint picker shows only on the checkpoint scope; picking the scope lands on the latest checkpoint (#619)', async () => {
  const user = userEvent.setup();
  const { onScope } = renderPane(withCheckpoints(), 'worktree');
  await within(pane()).findByRole('region', { name: 'src/a.ts' });
  expect(within(bar()).queryByRole('button', { name: 'ponto de restauração do diff' })).toBeNull();
  within(bar()).getByRole('button', { name: 'escopo do diff' }).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'ponto de restauração' }));
  expect(onScope).toHaveBeenCalledWith('checkpoint', 2);
});
