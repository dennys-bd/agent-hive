import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChangesPane } from '@/components/ChangesPane';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { localPairOf, taskPairOf } from '../fixtures/work';
import { FakeDiffEditor, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const ON_TASK: Activity = { kind: 'task', ...taskPairOf('I1'), task, runs: [], sessions: [], slept: [], status: 'working', worker: true };
const ON_LOCAL: Activity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], kept: [], slept: [] };
const HEAD_BASE = { against: 'head', label: 'HEAD', oid: 'o1', text: 'one\n' };
const TASK_BASE = { against: 'task', label: 'a1b2c3d (origin/main)', oid: 'o0', text: '' };
let bases: Record<string, unknown> = {};
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return jsonResponse({ version: 'v2' });
  if (url.includes('/file-base')) return jsonResponse(bases[new URL(url, 'http://hive').searchParams.get('against') ?? ''] ?? {});
  if (url.includes('/file-version')) return jsonResponse({ version: 'v1' });
  return jsonResponse({ path: 'src/a.ts', text: 'two\n', version: 'v1' });
});
const baseAsks = (): string[] => fetchMock.mock.calls.flatMap(([url]) => (url.includes('/file-base') ? [url] : []));
const pane = (activity: Activity) => <ChangesPane activity={activity} path="src/a.ts" label="#1 Task 1 · Alterações a.ts" active fontFamily="ui-monospace, monospace" />;

beforeEach(() => {
  setLanguage('pt');
  resetViewState();
  bases = { head: HEAD_BASE, task: TASK_BASE };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  models.closeExcept(new Set());
  fileBase.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('the selector reads HEAD and switches to the task base: the left side and the label follow, the pick kept in the view state; the right side is the file\'s own model (#668)', async () => {
  render(pane(ON_TASK));
  await waitFor(() => expect(FakeDiffEditor.all).toHaveLength(1));
  const diff = FakeDiffEditor.all[0];
  expect([diff.original.getValue(), diff.getModifiedEditor().model.getValue()]).toEqual(['one\n', 'two\n']);
  const selector = screen.getByRole('combobox', { name: 'base' });
  expect(selector).toHaveTextContent('HEAD');
  fireEvent.click(selector);
  fireEvent.click(await screen.findByRole('option', { name: 'base da tarefa' }));
  await waitFor(() => expect(diff.original.getValue()).toBe(''));
  expect(screen.getByText('a1b2c3d (origin/main)')).toBeInTheDocument();
  expect(readView('changesBase')).toEqual({ 'a-I1:src/a.ts': 'task' });
});

test('⌘S on the right side saves the file\'s buffer over the version it read (#668)', async () => {
  render(pane(ON_TASK));
  await waitFor(() => expect(FakeDiffEditor.all).toHaveLength(1));
  const right = FakeDiffEditor.all[0].getModifiedEditor();
  act(() => right.model.type('three\n'));
  act(() => right.onSave());
  await waitFor(() => expect(models.isDirty('a-I1', 'src/a.ts')).toBe(false));
  const puts = fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'PUT' ? [`${url} ${String(init.body)}`] : []));
  expect(puts).toEqual(['/activities/a-I1/file {"path":"src/a.ts","text":"three\\n","version":"v1","format":true}']);
});

test('a local activity\'s selector holds HEAD alone, disabled, and asks only HEAD (#668)', async () => {
  render(pane(ON_LOCAL));
  const selector = screen.getByRole('combobox', { name: 'base' });
  expect(selector).toBeDisabled();
  expect(selector).toHaveTextContent('HEAD');
  await waitFor(() => expect(FakeDiffEditor.all).toHaveLength(1));
  expect(baseAsks()).toContain('/activities/local%3Ahive/file-base?path=src%2Fa.ts&against=head');
  expect(baseAsks().some((url) => url.includes('against=task'))).toBe(false);
});

test('a base with no text says sem base para comparar, with no diff editor (#668)', async () => {
  bases = { head: { against: 'head', label: 'HEAD' } };
  render(pane(ON_TASK));
  expect(await screen.findByText('sem base para comparar')).toBeInTheDocument();
  expect(FakeDiffEditor.all).toEqual([]);
});

test('a first base answer that failed leaves the loading line for the no-base line (#668)', async () => {
  bases = {}; // an answer that is no base: the same failure a 409 or a network error leaves
  render(pane(ON_TASK));
  expect(await screen.findByText('sem base para comparar')).toBeInTheDocument();
  expect(screen.queryByText('carregando…')).toBeNull();
});

test('the modified editor takes focus when the tab becomes active (#668)', async () => {
  const { rerender } = render(<ChangesPane activity={ON_TASK} path="src/a.ts" label="l" active={false} fontFamily="ui-monospace" />);
  await waitFor(() => expect(FakeDiffEditor.all).toHaveLength(1));
  const right = FakeDiffEditor.all[0].getModifiedEditor();
  const focus = vi.spyOn(right, 'focus');
  rerender(<ChangesPane activity={ON_TASK} path="src/a.ts" label="l" active fontFamily="ui-monospace" />);
  expect(focus).toHaveBeenCalled();
});
