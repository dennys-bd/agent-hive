import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MainDock } from '@/components/MainDock';
import { type OpenFileHow, useOpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import * as models from '@/lib/editor-models';
import type { FileAt } from '@/lib/editor-models';
import type { Task, Worker } from '../../src/types';
import { jsonResponse } from '../fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { FakeEditor, FakeModel, resetMonacoFakes } from './monaco-fake';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Task A runs its stage (W1) in the worktree /w/hive-a; task C runs nothing, so it is no activity (#458)
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1', worktree: '/w/hive-a' };
const taskC: Task = { item: { itemId: 'C', id: '3', title: 'Task C', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const answers: boolean[] = [];
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
  (init?.method === 'POST' ? new Response(null, { status: 204 }) : jsonResponse({ path: 'docs/spec.md', text: '# spec\n', version: 'v1' })));
const posts = (): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'POST' ? [`${url} ${String(init.body)}`] : []));

// What every click on a file does (#717): hand the activity's key, the path and maybe a line to the dock's opener
function FileOpener({ name, activity, path, at, how }: { name: string; activity: string; path: string; at?: FileAt; how?: OpenFileHow }) {
  const openFile = useOpenFile();
  return <button type="button" onClick={() => answers.push(openFile?.(activity, path, at, how) ?? false)}>{name}</button>;
}
function Home() {
  const work = withPointedWork({ tasks: [taskA, taskC], workers: [workerA], terminals: [], activities: [], activityRecords: [] }); // #629
  const openers = (
    <>
      <FileOpener name="spec" activity="A" path="docs/spec.md" />
      <FileOpener name="spec preview" activity="A" path="docs/spec.md" how={{ preview: true }} />
      <FileOpener name="spec at 3" activity="A" path="/w/hive-a/docs/spec.md" at={{ line: 3 }} />
      <FileOpener name="outside" activity="A" path="/docs-repo/plan.md" at={{ line: 2 }} />
      <FileOpener name="no activity" activity="C" path="docs/spec.md" />
    </>
  );
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={['hive']} tasks={[taskA, taskC]} workers={[workerA]} liveActivities={work.activities} activityRecords={work.activityRecords}
      terminals={[]} onSelect={() => {}} detail={() => openers} automation={() => <p>automação</p>}
    >
      <main>fluxo</main>
    </MainDock>
  );
}
const click = (name: string): void => { fireEvent.click(screen.getByRole('button', { name, hidden: true })); };

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  answers.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('a file of a listed activity opens as an editor pane tab of its center, once: a second open by its absolute path at a line selects it and puts the cursor there; an activity not listed answers false (#717)', async () => {
  render(<Home />);
  click('no activity');
  expect(answers).toEqual([false]);
  click('spec');
  expect(within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]))
    .toEqual([['Claude', 'false'], ['spec.md', 'true']]);
  expect(screen.getByRole('tab', { name: 'spec.md' })).toHaveAttribute('title', 'docs/spec.md');
  expect(screen.getByRole('region', { name: '#1 Task A · spec.md' })).toBeInTheDocument();
  await waitFor(() => expect(FakeEditor.all).toHaveLength(1));
  click('spec at 3');
  expect(screen.getAllByRole('tab', { name: 'spec.md' })).toHaveLength(1);
  expect(FakeEditor.all[0].position).toEqual({ lineNumber: 3, column: 1 });
  expect(answers).toEqual([false, true, true]);
});

test('an absolute path outside the activity\'s worktree opens in its editor pane too, its tab keyed by that path (#697)', () => {
  render(<Home />);
  click('outside');
  expect(screen.getByRole('tab', { name: 'plan.md' })).toHaveAttribute('title', '/docs-repo/plan.md');
  expect(posts()).toEqual([]);
  expect(answers).toEqual([true]);
});

test('the page asks before it unloads while a buffer holds unsaved edits, and lets it go when none does (#717)', async () => {
  render(<Home />);
  click('spec');
  await waitFor(() => expect(FakeModel.all).toHaveLength(1));
  const isHeld = (): boolean => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  expect(isHeld()).toBe(false);
  act(() => FakeModel.all[0].type('edited'));
  expect(isHeld()).toBe(true);
});

test('a detached window\'s file link, forwarded by main, opens in its activity\'s editor pane at its line (#717)', async () => {
  let forward: ((file: unknown) => void) | undefined;
  vi.stubGlobal('hive', { onDock: () => {}, onCloseKey: () => () => {}, onOpenFile: (callback: (file: unknown) => void) => { forward = callback; return () => {}; } });
  render(<Home />);
  act(() => forward?.({ task: 'A', path: 'docs/spec.md', line: 4 }));
  expect(screen.getByRole('tab', { name: 'spec.md' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(FakeEditor.all[0]?.position).toEqual({ lineNumber: 4, column: 1 }));
});

test('a file opened as a preview takes a preview tab of its own beside its editor tab, once (#697)', () => {
  render(<Home />);
  click('spec');
  click('spec preview');
  click('spec preview');
  expect(within(screen.getByRole('tablist', { name: 'abas' })).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]))
    .toEqual([['Claude', 'false'], ['spec.md', 'false'], ['Preview spec.md', 'true']]);
  expect(answers).toEqual([true, true, true]);
});
