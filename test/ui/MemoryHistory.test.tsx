import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryHistory } from '@/components/settings/MemoryHistory';
import { setLanguage } from '@/i18n';
import type { MemoryChange, MemoryEntry, MemoryView } from '../../src/types';
import { jsonResponse } from '../fakes';

// The memory dialog's history (#684): the changes agents made, newest first, each restored or discarded at once through its route
const BODY_9 = 'The dev server reads its port from PORT; never hardcode 5173.\n\nWhy: every worktree runs its own server.';
const lessonOf = (id: string, description: string, body: string): MemoryEntry =>
  ({ id, kind: 'fact', description, body, origin: 'user', at: '2026-09-14T10:00:00.000Z', uses: 4 });
const H1: MemoryChange = { id: 'h-1', entry: lessonOf('m-2', 'Where the UI copy lives', 'All UI text lives in src/ui/strings.ts.'), action: 'revised', by: { task: '702', stage: 'spec' }, why: 'the UI text moved to src/ui/i18n.ts', at: '2026-10-28T10:00:00.000Z' };
const H2: MemoryChange = { id: 'h-2', entry: lessonOf('m-7', 'Output order in CI', 'CI runs on Linux.'), action: 'revised', by: 'local', why: 'a Promise.all order changes on Linux too', at: '2026-11-04T10:00:00.000Z' };
const H3: MemoryChange = { id: 'h-3', entry: lessonOf('m-9', 'The dev server port', BODY_9), action: 'removed', by: { task: '741', stage: 'build' }, why: 'the server reads HIVE_PORT now', at: '2026-11-05T10:00:00.000Z' };
const VIEW: MemoryView = { entries: [], history: [H1, H2, H3], used: 0, cap: 4000, descriptionMax: 150, bodyMax: 4000 }; // stored oldest first
let refusal: { status: number; code: string } | undefined;
let current: MemoryView = VIEW; // the view the mock keeps, so that two calls chain

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (refusal) return jsonResponse({ error: 'refused', code: refusal.code }, refusal.status);
  const change = current.history.find((c) => url.includes(`/history/${c.id}`));
  if (!change) return jsonResponse({ error: 'unknown workspace' }, 404);
  const entries = init?.method === 'POST' ? [...current.entries, change.entry] : current.entries;
  current = { ...current, entries, history: current.history.filter((c) => c !== change) };
  return jsonResponse(current);
});

beforeEach(() => { setLanguage('pt'); refusal = undefined; current = VIEW; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

// The section over its own view, as the dialog holds it: every answer is applied
function Harness({ view = VIEW }: { view?: MemoryView }) {
  const [shown, setShown] = useState(view);
  return <MemoryHistory workspace="hive" view={shown} onView={setShown} />;
}
const history = (name = 'histórico') => within(screen.getByRole('region', { name }));
// the reason's label and text are two spans of one line, so it is matched by the line's whole text
const reason = (text: string) => (_: string, el: Element | null): boolean => el?.tagName === 'P' && el.textContent === text;

test('the history lists the changes newest first: the lesson\'s id, the action, the description, the reason, and who made it, when and the kind it had (#684)', () => {
  render(<Harness />);
  const list = history();
  expect(list.getByText('3 mudanças · guarda as 50 mais recentes')).toBeInTheDocument();
  expect(['chave', 'mudança', 'lição como era'].map((text) => list.getByText(text))).toHaveLength(3);
  expect(list.getAllByRole('button', { name: /^restaurar / }).map((b) => b.getAttribute('aria-label'))).toEqual(['restaurar m-9 como era', 'restaurar m-7 como era', 'restaurar m-2 como era']);
  expect(list.getByText('m-9')).toHaveAttribute('title', 'm-9');
  expect([list.getAllByText('removida'), list.getAllByText('revisada')].map((badges) => badges.length)).toEqual([1, 2]);
  expect(list.getByRole('button', { name: 'The dev server port' })).toBeInTheDocument();
  expect(list.getByText(reason('motivo: the server reads HIVE_PORT now'))).toBeInTheDocument();
  expect(list.getByText('por tarefa #741 · build · 2026-11-05 · era fato do código')).toBeInTheDocument();
  expect(list.getByText('por sessão local · 2026-11-04 · era fato do código')).toBeInTheDocument();
  expect(list.getByText('por tarefa #702 · spec · 2026-10-28 · era fato do código')).toBeInTheDocument();
  expect(list.getByRole('button', { name: 'descartar a mudança de m-9' })).toHaveAttribute('title', 'descartar a mudança de m-9');
});

test('a change\'s description opens and closes the lesson\'s body as it was, closed at first (#684)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const port = history().getByRole('button', { name: 'The dev server port' });
  const body = document.getElementById(port.getAttribute('aria-controls') ?? '');
  expect([port.getAttribute('aria-expanded'), body?.textContent]).toEqual(['false', BODY_9]);
  expect(body).not.toBeVisible();
  await user.click(port);
  expect(port).toHaveAttribute('aria-expanded', 'true');
  expect(body).toBeVisible();
});

test('restore calls the change\'s route and hands the new view up: the row leaves, the count follows and the focus goes to the next change (#684)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const list = history();
  await user.click(list.getByRole('button', { name: 'restaurar m-9 como era' }));
  await waitFor(() => expect(list.queryByRole('button', { name: 'restaurar m-9 como era' })).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith('/workspaces/hive/memory/history/h-3/restore', expect.objectContaining({ method: 'POST' }));
  expect(list.getByText('2 mudanças · guarda as 50 mais recentes')).toBeInTheDocument();
  expect(list.getByRole('button', { name: 'Output order in CI' })).toHaveFocus();
});

test('a refused restore says why on its own row with role alert and the change stays; a change no longer there reads unknown_change (#684)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const list = history();
  refusal = { status: 409, code: 'memory_full' };
  const restore = list.getByRole('button', { name: 'restaurar m-9 como era' });
  await user.click(restore);
  const alert = await list.findByRole('alert');
  expect(alert).toHaveTextContent('a memória está cheia: remova uma lição ou encurte uma descrição');
  expect(alert.parentElement?.parentElement).toContainElement(restore); // under the lesson column of the same row
  expect(list.getByText('3 mudanças · guarda as 50 mais recentes')).toBeInTheDocument();
  refusal = { status: 404, code: 'unknown_memory' };
  await user.click(list.getByRole('button', { name: 'descartar a mudança de m-7' }));
  await waitFor(() => expect(list.getAllByRole('alert').map((a) => a.textContent)).toContain('esta mudança não está mais no histórico'));
  expect(list.getByRole('button', { name: 'descartar a mudança de m-7' })).toBeInTheDocument();
});

test('discard calls the change\'s route at once, with no confirmation; with no change after it, the focus goes to the title (#684)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const list = history();
  await user.click(list.getByRole('button', { name: 'descartar a mudança de m-2' }));
  await waitFor(() => expect(list.queryByRole('button', { name: 'descartar a mudança de m-2' })).not.toBeInTheDocument());
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/workspaces/hive/memory/history/h-1', expect.objectContaining({ method: 'DELETE' }));
  expect(list.getByRole('heading', { name: 'histórico' })).toHaveFocus();
});

test('an empty history keeps its frame and its header and says where an agent\'s change lands (#684)', () => {
  render(<Harness view={{ ...VIEW, history: [] }} />);
  const list = history();
  expect(list.getByText('0 mudanças · guarda as 50 mais recentes')).toBeInTheDocument();
  expect(list.getByText('lição como era')).toBeInTheDocument();
  expect(list.getByText('nenhuma mudança ainda · quando um agente corrige ou remove uma lição, a lição como era aparece aqui')).toBeInTheDocument();
  expect(list.queryByRole('button')).not.toBeInTheDocument();
});

test('a change reads in English (#684)', () => {
  setLanguage('en');
  render(<Harness view={{ ...VIEW, history: [H3] }} />);
  const list = history('history');
  expect(list.getByText('1 change · keeps the newest 50')).toBeInTheDocument();
  expect(['key', 'change', 'lesson as it was', 'removed'].map((text) => list.getByText(text))).toHaveLength(4);
  expect(list.getByText(reason('reason: the server reads HIVE_PORT now'))).toBeInTheDocument();
  expect(list.getByText('by task #741 · build · 2026-11-05 · was codebase fact')).toBeInTheDocument();
  expect(list.getByRole('button', { name: 'restore m-9 as it was' })).toBeInTheDocument();
  expect(list.getByRole('button', { name: 'discard the change to m-9' })).toBeInTheDocument();
});
