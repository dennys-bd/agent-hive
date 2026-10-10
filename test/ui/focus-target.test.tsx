import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { readFocusTarget } from '@/lib/focus-target';
import { stateOf, task } from './search-fixtures';
import { activityIdOf, bareTask } from '../fixtures/work';
import { localActivityId } from '../../src/activities';

const build = task('11', 'Build', { worktree: '/w/11' });
const state = stateOf([build], { terminals: [{ terminalId: 'W2', activityId: activityIdOf('I11'), startedAt: '2026-09-28T10:00:00.000Z', cwd: '/repo' }] });

test('an element inside a terminal tab reads as that terminal, with its task and its run (#584)', () => {
  render(<section data-pty-id="W2"><textarea aria-label="xterm" /></section>);
  screen.getByLabelText('xterm').focus();
  expect(readFocusTarget(state)).toEqual({ kind: 'terminal', run: { ptyId: 'W2', label: 'Terminal', kind: 'terminal' } });
});

test('a focused board task reads as its task (#584)', () => {
  render(<button type="button" data-task-id="I11">task</button>);
  screen.getByRole('button').focus();
  expect(readFocusTarget(state)).toEqual({ kind: 'task', task: bareTask(build) }); // #629: the worktree is its activity's
});

test('anything else reads as nothing: the body, a plain field, a terminal whose run is gone (#584)', () => {
  expect(readFocusTarget(state)).toBeUndefined();
  render(<><input aria-label="plain" /><section data-pty-id="GONE"><textarea aria-label="old" /></section></>);
  screen.getByLabelText('plain').focus();
  expect(readFocusTarget(state)).toBeUndefined();
  screen.getByLabelText('old').focus();
  expect(readFocusTarget(state)).toBeUndefined();
});

test('an element inside a workspace\'s local terminal reads as that terminal, with no task (#584, #590)', () => {
  const local = stateOf([build], { terminals: [{ terminalId: 'W3', activityId: localActivityId('hive'), startedAt: '2026-09-28T10:00:00.000Z', cwd: '/repo' }] });
  render(<section data-pty-id="W3"><textarea aria-label="xterm" /></section>);
  screen.getByLabelText('xterm').focus();
  expect(readFocusTarget(local)).toEqual({ kind: 'terminal', run: { ptyId: 'W3', label: 'Terminal', kind: 'terminal' } });
});

test('an element inside an editor pane reads as its file, with its activity (#697)', () => {
  render(<section data-file-activity="a-I11" data-file-path="docs/plan.md"><textarea aria-label="monaco" /></section>);
  screen.getByLabelText('monaco').focus();
  expect(readFocusTarget(state)).toEqual({ kind: 'file', activityId: 'a-I11', path: 'docs/plan.md' });
});
