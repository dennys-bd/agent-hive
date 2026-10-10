import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryLessons } from '@/components/settings/MemoryLessons';
import { setLanguage } from '@/i18n';
import type { MemoryEntry, MemoryView } from '../../src/types';
import { jsonResponse } from '../fakes';

// The memory dialog's lessons (#797): the filter, the table and its single editing row, over the routes, never the Settings draft
const VIEW: MemoryView = {
  used: 87, cap: 4000, textMax: 300,
  entries: [
    { id: 'm-1', kind: 'fact', text: 'pnpm test runs lint, tsc and both runners', origin: { task: '812', stage: 'build' }, at: '2026-10-01T10:00:00.000Z', uses: 5, lastUsed: { at: '2026-10-04T09:00:00.000Z', task: '812', stage: 'build', why: 'ran the full gate before committing' } },
    { id: 'm-2', kind: 'pref', text: 'write specs in English', origin: { task: '790' }, at: '2026-10-02T10:00:00.000Z', uses: 1, lastUsed: { at: '2026-10-04T10:00:00.000Z', task: '790', why: 'wrote it in English' } },
    { id: 'm-3', kind: 'avoid', text: 'never edit dist/ by hand', origin: 'user', at: '2026-10-03T10:00:00.000Z', uses: 0 },
  ],
};
const ADDED: MemoryEntry = { id: 'm-4', kind: 'fact', text: 'never push to main', origin: 'user', at: '2026-10-05T10:00:00.000Z', uses: 0 };
let refuseWrites = false;

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (method === 'POST' && refuseWrites) return jsonResponse({ error: 'memory is full; go on without saving this lesson', code: 'memory_full' }, 409);
  if (method === 'POST') return jsonResponse({ ...VIEW, entries: [...VIEW.entries, ADDED] });
  if (method === 'DELETE' && url === '/workspaces/hive/memory/m-3') return jsonResponse({ ...VIEW, entries: VIEW.entries.slice(0, 2) });
  return jsonResponse({ error: 'unknown workspace' }, 404);
});

beforeEach(() => { setLanguage('pt'); refuseWrites = false; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

// The table over its own view, as the dialog holds it: every answer is applied
function Harness() {
  const [view, setView] = useState(VIEW);
  return <MemoryLessons workspace="hive" view={view} onView={setView} />;
}
const lessons = (name = 'lições'): ReturnType<typeof within> => within(screen.getByRole('region', { name }));

test('each lesson shows its id, its kind and its meta line, with the last why as the title of its citations (#797)', () => {
  render(<Harness />);
  const table = lessons();
  expect(table.getByText('m-1')).toHaveAttribute('title', 'm-1');
  expect(table.getByText('fato do código')).toBeInTheDocument();
  expect(table.getByText(/^tarefa #812 · build · 2026-10-01 · 41 caracteres/)).toBeInTheDocument();
  expect(table.getByText(/^tarefa #790 · 2026-10-02 · 22 caracteres/)).toBeInTheDocument();
  expect(table.getByText(/^você · 2026-10-03 · 24 caracteres/)).toBeInTheDocument();
  expect(table.getByText('citada 5 vezes')).toHaveAttribute('title', 'ran the full gate before committing');
  expect(table.getByText('citada 1 vez')).toBeInTheDocument();
  expect(table.getByText('citada 0 vezes')).not.toHaveAttribute('title');
});

test('the filter counts each kind and shows only its lessons; ✕ removes a lesson at once and an empty kind says so (#797)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  expect(table.getAllByRole('radio').map((r: HTMLElement) => r.textContent)).toEqual(['todas · 3', 'preferência · 1', 'fato do código · 1', 'evitar · 1']);
  await user.click(table.getByRole('radio', { name: 'evitar · 1' }));
  expect(table.getByText('never edit dist/ by hand')).toBeInTheDocument();
  expect(table.queryByText('write specs in English')).not.toBeInTheDocument();
  await user.click(table.getByRole('button', { name: 'remover lição m-3' }));
  await waitFor(() => expect(table.queryByText('never edit dist/ by hand')).not.toBeInTheDocument());
  expect(table.getByText('nenhuma lição deste tipo')).toBeInTheDocument();
  expect(table.getByRole('radio', { name: 'evitar · 0' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/workspaces/hive/memory/m-3', expect.objectContaining({ method: 'DELETE' }));
});

test('+ lesson brings the filter back to all and adds an editing row at the end, with no id yet; saved, it becomes a lesson (#797)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('radio', { name: 'preferência · 1' }));
  await user.click(table.getByRole('button', { name: '+ lição' }));
  expect(table.getByRole('radio', { name: 'todas · 3' })).toHaveAttribute('data-state', 'on');
  const field = table.getByRole('textbox', { name: 'texto da lição' });
  expect(table.getByText('never edit dist/ by hand').compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(table.getByText('—')).toBeInTheDocument();
  await user.type(field, 'never push to main');
  await user.click(table.getByRole('button', { name: 'salvar' }));
  expect(await table.findByText('never push to main')).toBeInTheDocument();
  expect(table.queryByRole('textbox')).not.toBeInTheDocument();
  const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST') ?? [];
  expect(init?.body).toBe(JSON.stringify({ kind: 'fact', text: 'never push to main' }));
});

test('only one row edits at a time; cancel leaves it as it was (#797)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: 'editar lição m-1' }));
  expect(table.getByRole('textbox', { name: 'texto da lição' })).toHaveValue(VIEW.entries[0].text);
  await user.click(table.getByRole('button', { name: 'editar lição m-2' }));
  expect(table.getAllByRole('textbox')).toHaveLength(1);
  expect(table.getByRole('textbox', { name: 'texto da lição' })).toHaveValue('write specs in English');
  await user.click(table.getByRole('button', { name: 'cancelar' }));
  expect(table.queryByRole('textbox')).not.toBeInTheDocument();
  expect(table.getByText('write specs in English')).toBeInTheDocument();
});

test('past 300 characters the counter says so, the field is invalid and save is off; a refusal shows under the field and the text stays (#797)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: '+ lição' }));
  const field = table.getByRole('textbox', { name: 'texto da lição' });
  await user.click(field);
  await user.paste('x'.repeat(301));
  expect(table.getByText('301 de 300 caracteres')).toBeInTheDocument();
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(table.getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.clear(field);
  refuseWrites = true;
  await user.type(field, 'never push to main{Enter}');
  expect(await table.findByRole('alert')).toHaveTextContent('a memória está cheia: remova ou encurte uma lição');
  expect(field).toHaveValue('never push to main');
});

test('Enter picked in an IME composition saves nothing; outside one it saves and never breaks the line (#797)', async () => {
  render(<Harness />);
  const table = lessons();
  fireEvent.click(table.getByRole('button', { name: '+ lição' }));
  const field = table.getByRole('textbox', { name: 'texto da lição' });
  fireEvent.change(field, { target: { value: 'never push to main' } });
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(field, { key: 'Enter' }), 'default prevented: no line break').toBe(false);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});

test('the table reads in English (#797)', () => {
  setLanguage('en');
  render(<Harness />);
  const table = lessons('lessons');
  expect(table.getAllByRole('radio').map((r: HTMLElement) => r.textContent)).toEqual(['all · 3', 'preference · 1', 'codebase fact · 1', 'avoid · 1']);
  expect(table.getByText(/^task #812 · build · 2026-10-01 · 41 characters/)).toBeInTheDocument();
  expect(table.getByText(/^you · 2026-10-03 · 24 characters/)).toBeInTheDocument();
  expect([table.getByText('cited 5 times'), table.getByText('cited 1 time')]).toHaveLength(2);
  expect(table.getByRole('button', { name: '+ lesson' })).toBeInTheDocument();
});
