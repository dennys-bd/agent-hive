import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ResultsList } from '@/components/DetailSections';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, TaskFile } from '../../src/types';
import { jsonResponse } from '../fakes';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const FILES: TaskFile[] = [{ key: 'spec', path: 'docs/spec.md', base: 'worktree' }, { key: 'data', path: '/docs-repo/data.json', base: 'outside' }];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.mocked(toast.error).mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('a markdown result file opens in its activity\'s preview pane, any other in its editor pane; one the dock does not take posts nothing and says why (#629, #717, #697, #818)', async () => {
  const user = userEvent.setup();
  const openFile = vi.fn<OpenFile>(() => true);
  render(<FileOpenerContext.Provider value={openFile}><ResultsList task={task} files={FILES} /></FileOpenerContext.Provider>);
  await user.click(screen.getByRole('button', { name: 'spec.md' }));
  await user.click(screen.getByRole('button', { name: 'data.json' }));
  expect(openFile.mock.calls).toEqual([['I1', 'docs/spec.md', undefined, { preview: true }], ['I1', '/docs-repo/data.json', undefined, undefined]]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  openFile.mockReturnValue(false);
  await user.click(screen.getByRole('button', { name: 'spec.md' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith('esta atividade foi apagada: os arquivos dela não abrem mais');
});

test('results list only the stage files: a task\'s PRs show in the PRs field, never again here; no files means no section (#809)', () => {
  const { container, rerender } = render(<ResultsList task={task} files={FILES} />);
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['spec.md', 'data.json']);
  rerender(<ResultsList task={task} files={[]} />);
  expect(container).toBeEmptyDOMElement();
});
