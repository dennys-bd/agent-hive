import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PreviewPane } from '@/components/PreviewPane';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import * as models from '@/lib/editor-models';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { taskPairOf } from '../fixtures/work';
import { FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const A = 'a-I1';
const PATH = 'docs/plans/p.md';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const activity: Activity = { kind: 'task', ...taskPairOf('I1', { worktree: '/w/hive-1' }), task, runs: [], sessions: [], status: 'working', worker: true };
// What the disk answers: the file's read (any path) and its version
let disk: { status: number; body: unknown } = { status: 200, body: { path: PATH, text: '# Disk\n', version: 'v1' } };
let version = 'v1';
const diskFetch = async (url: string) => (url.includes('/file-version') ? jsonResponse({ version }) : jsonResponse(disk.body, disk.status));
const fetchMock = vi.fn(diskFetch);
const openFile = vi.fn<OpenFile>(() => true);
const fileOf = (text: string, at = 'v1') => ({ status: 200, body: { path: PATH, text, version: at } });
const pane = (path = PATH) => (
  <FileOpenerContext.Provider value={openFile}><PreviewPane activity={activity} path={path} label="#1 Task 1 · Preview p.md" active /></FileOpenerContext.Provider>
);
// The ids (else names) scrollIntoView was called on, in order
function trackScrolls(): string[] {
  const scrolled: string[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this.id || this.getAttribute('name') || ''); });
  return scrolled;
}

beforeEach(() => {
  setLanguage('pt');
  disk = fileOf('# Disk\n');
  version = 'v1';
  fetchMock.mockClear();
  fetchMock.mockImplementation(diskFetch);
  openFile.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('renders the disk\'s text and reads it again when its version moves (#697)', async () => {
  render(pane());
  expect(await screen.findByRole('heading', { level: 1, name: 'Disk' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '#1 Task 1 · Preview p.md' })).toBeInTheDocument();
  disk = fileOf('# Moved\n', 'v2');
  version = 'v2';
  fireEvent.focus(window);
  expect(await screen.findByRole('heading', { level: 1, name: 'Moved' })).toBeInTheDocument();
});

test('follows an editor buffer\'s unsaved text, and goes back to the disk once the buffer closes (#697)', async () => {
  await models.open(A, PATH);
  const model = FakeModel.all[0];
  render(pane());
  expect(screen.getByRole('heading', { level: 1, name: 'Disk' })).toBeInTheDocument();
  act(() => model.type('# Mine\n'));
  expect(screen.getByRole('heading', { level: 1, name: 'Mine' })).toBeInTheDocument();
  disk = fileOf('# Saved\n', 'v2');
  act(() => models.close(A, PATH));
  expect(await screen.findByRole('heading', { level: 1, name: 'Saved' })).toBeInTheDocument();
});

test('#x scrolls to x inside the pane, else to user-content-x (#697)', async () => {
  const user = userEvent.setup();
  const scrolled = trackScrolls();
  disk = fileOf('[go](#part-two) [raw](#x)\n\n<a id="x"></a>\n\n## Part two\n');
  render(pane());
  await user.click(await screen.findByRole('link', { name: 'go' }));
  await user.click(screen.getByRole('link', { name: 'raw' }));
  expect(scrolled).toEqual(['user-content-part-two', 'user-content-x']);
});

test('#x also finds a raw <a name="x">, which the sanitizer turns into name=user-content-x with no id (#697)', async () => {
  const user = userEvent.setup();
  const scrolled = trackScrolls();
  disk = fileOf('[j](#x)\n\n<a name="x"></a>\n');
  render(pane());
  await user.click(await screen.findByRole('link', { name: 'j' }));
  expect(scrolled).toEqual(['user-content-x']);
});

test('a link to a preview that is already mounted scrolls it at once, and leaves nothing pending for a later mount (#697)', async () => {
  const user = userEvent.setup();
  const scrolled = trackScrolls();
  const target = 'docs/specs/s.md';
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/file-version')) return jsonResponse({ version });
    const text = url.includes('s.md') ? '## Closed\n' : '[spec](../specs/s.md#closed)\n';
    return jsonResponse({ path: PATH, text, version });
  });
  const both = (
    <FileOpenerContext.Provider value={openFile}>
      <PreviewPane activity={activity} path={PATH} label="a" active />
      <PreviewPane activity={activity} path={target} label="b" active />
    </FileOpenerContext.Provider>
  );
  const { unmount } = render(both);
  await screen.findByRole('heading', { name: 'Closed' });
  await user.click(await screen.findByRole('link', { name: 'spec' }));
  expect(scrolled).toEqual(['user-content-closed']);
  unmount();
  scrolled.length = 0;
  render(<FileOpenerContext.Provider value={openFile}><PreviewPane activity={activity} path={target} label="b" active /></FileOpenerContext.Provider>);
  await screen.findByRole('heading', { name: 'Closed' });
  expect(scrolled).toEqual([]);
});

test('an open that fails, or a target that cannot be read, drops the anchor it asked for (#697)', async () => {
  const user = userEvent.setup();
  const scrolled = trackScrolls();
  disk = fileOf('[spec](../specs/s.md#closed)\n');
  openFile.mockReturnValueOnce(false);
  const { unmount } = render(pane());
  await user.click(await screen.findByRole('link', { name: 'spec' }));
  unmount();
  disk = fileOf('## Closed\n');
  const second = render(pane('docs/specs/s.md'));
  await screen.findByRole('heading', { name: 'Closed' });
  second.unmount();
  disk = { status: 404, body: { error: 'file not found' } };
  render(pane('docs/specs/gone.md'));
  expect(scrolled).toEqual([]);
});

test('once the editor tab closes, the preview does not flash the disk text read before the edits (#697)', async () => {
  render(pane());
  await screen.findByRole('heading', { level: 1, name: 'Disk' });
  await models.open(A, PATH);
  const model = FakeModel.all[0];
  act(() => model.type('# Mine\n'));
  disk = fileOf('# Saved\n', 'v2');
  act(() => models.close(A, PATH));
  expect(screen.queryByRole('heading', { level: 1, name: 'Disk' })).toBeNull();
  expect(await screen.findByRole('heading', { level: 1, name: 'Saved' })).toBeInTheDocument();
});

test('a relative markdown link opens its preview and any other file a file tab, both from the previewed file\'s folder; the target preview scrolls to the link\'s anchor (#697)', async () => {
  const user = userEvent.setup();
  const scrolled = trackScrolls();
  disk = fileOf('[spec](../specs/s.md#closed) [code](../../src/a.ts?raw)\n');
  render(pane());
  await user.click(await screen.findByRole('link', { name: 'spec' }));
  await user.click(screen.getByRole('link', { name: 'code' }));
  expect(openFile.mock.calls).toEqual([
    ['I1', 'docs/plans/../specs/s.md', undefined, { preview: true }],
    ['I1', 'docs/plans/../../src/a.ts', undefined, undefined],
  ]);
  disk = fileOf('## Closed\n');
  render(pane('docs/specs/s.md'));
  expect(await screen.findByRole('heading', { level: 2, name: 'Closed' })).toBeInTheDocument();
  expect(scrolled).toEqual(['user-content-closed']);
});

test('a read the server refuses shows the editor pane\'s words (#697)', async () => {
  disk = { status: 404, body: { error: 'file not found' } };
  render(pane());
  expect(await screen.findByRole('alert')).toHaveTextContent('arquivo não encontrado');
  expect(screen.queryByRole('button', { name: 'abrir na IDE' })).not.toBeInTheDocument();
});

test('a task\'s repository links its #N references (#697)', async () => {
  const repoTask: Task = { ...task, item: { ...task.item, facets: { assignees: [], labels: [], repository: 'acme/app', fields: {} } } };
  const repoActivity: Activity = { ...activity, task: repoTask } as Activity;
  disk = fileOf('see #12\n');
  render(<PreviewPane activity={repoActivity} path={PATH} label="preview" active />);
  expect(await screen.findByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://github.com/acme/app/issues/12');
});
