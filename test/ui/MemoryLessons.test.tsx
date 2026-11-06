import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryLessons } from '@/components/settings/MemoryLessons';
import { setLanguage } from '@/i18n';
import type { MemoryEntry, MemoryView } from '../../src/types';
import { jsonResponse } from '../fakes';

// The memory dialog's lessons (#797): the filter, the table and its single editing row, over the routes, never the Settings draft
const BODY_1 = 'lint, tsc, node:test and vitest, in parallel';
const BODY_2 = 'specs, plans, commits and PRs are written in English';
const BODY_3 = 'it is generated: rebuild instead';
const VIEW: MemoryView = {
  used: 87, cap: 4000, descriptionMax: 150, bodyMax: 4000,
  entries: [
    { id: 'm-1', kind: 'fact', description: 'pnpm test runs lint, tsc and both runners', body: BODY_1, origin: { task: '812', stage: 'build' }, at: '2026-10-01T10:00:00.000Z', uses: 5, lastUsed: { at: '2026-10-04T09:00:00.000Z', task: '812', stage: 'build' } },
    { id: 'm-2', kind: 'pref', description: 'write specs in English', body: BODY_2, origin: { task: '790' }, at: '2026-10-02T10:00:00.000Z', uses: 1, lastUsed: { at: '2026-10-04T10:00:00.000Z', task: '790' } },
    { id: 'm-3', kind: 'avoid', description: 'never edit dist/ by hand', body: BODY_3, origin: 'user', at: '2026-10-03T10:00:00.000Z', uses: 0 },
  ],
};
const ADDED: MemoryEntry = { id: 'm-4', kind: 'fact', description: 'never push to main', body: '', origin: 'user', at: '2026-10-05T10:00:00.000Z', uses: 0 };
let refuseWrites = false;
let current: MemoryView = VIEW; // the view the mock keeps, so that two removals chain

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (method === 'POST' && refuseWrites) return jsonResponse({ error: 'memory is full; go on without saving this lesson', code: 'memory_full' }, 409);
  if (method === 'POST') return jsonResponse({ ...VIEW, entries: [...VIEW.entries, ADDED] });
  if (method === 'PUT') return jsonResponse({ ...VIEW, entries: [{ ...VIEW.entries[0], description: 'pnpm test is the only gate' }, ...VIEW.entries.slice(1)] });
  if (method === 'DELETE') {
    current = { ...current, entries: current.entries.filter((e) => !url.endsWith(`/${e.id}`)) };
    return jsonResponse(current);
  }
  return jsonResponse({ error: 'unknown workspace' }, 404);
});

beforeEach(() => { setLanguage('pt'); refuseWrites = false; current = VIEW; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

// The table over its own view, as the dialog holds it: every answer is applied
function Harness() {
  const [view, setView] = useState(VIEW);
  return <MemoryLessons workspace="hive" view={view} onView={setView} />;
}
const field = (table: ReturnType<typeof within>, name: string): HTMLElement => table.getByRole('textbox', { name });
const lessons = (name = 'lições'): ReturnType<typeof within> => within(screen.getByRole('region', { name }));

test('each lesson shows its id, its kind and its meta line, its count of uses with no title (#797, #681)', () => {
  render(<Harness />);
  const table = lessons();
  expect(table.getByText('m-1')).toHaveAttribute('title', 'm-1');
  expect(table.getByText('fato do código')).toBeInTheDocument();
  expect(table.getByText(new RegExp(`^tarefa #812 · build · 2026-10-01 · descrição 41 · corpo ${BODY_1.length} caracteres`))).toBeInTheDocument();
  expect(table.getByText(new RegExp(`^tarefa #790 · 2026-10-02 · descrição 22 · corpo ${BODY_2.length} caracteres`))).toBeInTheDocument();
  expect(table.getByText(new RegExp(`^você · 2026-10-03 · descrição 24 · corpo ${BODY_3.length} caracteres`))).toBeInTheDocument();
  expect(table.getByText('citada 5 vezes')).not.toHaveAttribute('title');
  expect(table.getByText('citada 1 vez')).toBeInTheDocument();
});

test('a lesson\'s description opens and closes its body, collapsed at first and independently per row; the meta line comes last (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  const first = table.getByRole('button', { name: 'pnpm test runs lint, tsc and both runners' });
  const second = table.getByRole('button', { name: 'write specs in English' });
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(table.getByText(BODY_1)).not.toBeVisible();
  await user.click(first);
  expect(first).toHaveAttribute('aria-expanded', 'true');
  expect(document.getElementById(first.getAttribute('aria-controls') ?? '')).toHaveTextContent(BODY_1);
  expect(table.getByText(BODY_1)).toBeVisible();
  expect(table.getByText(BODY_2)).not.toBeVisible();
  await user.click(second);
  expect(table.getByText(BODY_1)).toBeVisible();
  expect(table.getByText(BODY_2)).toBeVisible();
  await user.click(first);
  expect(table.getByText(BODY_1)).not.toBeVisible();
  expect(table.getByText(BODY_2)).toBeVisible();
  const meta = table.getByText(new RegExp(`^tarefa #812 · build · 2026-10-01 · descrição 41 · corpo ${BODY_1.length} caracteres`));
  expect(table.getByText(BODY_1).compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a body keeps its line feeds and tabs as written (#680)', () => {
  const body = 'a\n\tb';
  render(<MemoryLessons workspace="hive" view={{ ...VIEW, entries: [{ ...VIEW.entries[0], body }] }} onView={vi.fn()} />);
  expect(document.getElementById(lessons().getByRole('button', { name: VIEW.entries[0].description }).getAttribute('aria-controls') ?? '')?.textContent).toBe(body);
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

test('+ lesson adds an editing row at the end with both fields, their hints, counters and placeholders; saved, it sends kind, description and body (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('radio', { name: 'preferência · 1' }));
  await user.click(table.getByRole('button', { name: '+ lição' }));
  expect(table.getByRole('radio', { name: 'todas · 3' })).toHaveAttribute('data-state', 'on');
  const description = field(table, 'descrição');
  const body = field(table, 'corpo');
  expect(description).toHaveAttribute('placeholder', 'Idioma da copy de uma execução');
  expect(body).toHaveAttribute('placeholder', 'a lição em si · por quê: … · como aplicar: …');
  expect(body).toHaveAttribute('rows', '7');
  expect(table.getByText('sobre o que é a lição, curto e direto')).toBeInTheDocument();
  expect(table.getByText('a lição, por que vale e como aplicar')).toBeInTheDocument();
  expect(table.getByText('0 de 150 caracteres')).toBeInTheDocument();
  expect(table.getByText('0 de 4.000 caracteres')).toBeInTheDocument();
  expect(table.getByText('você · agora')).toBeInTheDocument();
  expect(table.getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.type(description, 'never push to main');
  expect(table.getByRole('button', { name: 'salvar' })).toBeDisabled(); // the body is still empty
  await user.type(body, 'open a PR instead');
  await user.click(table.getByRole('button', { name: 'salvar' }));
  expect(await table.findByRole('button', { name: 'never push to main' })).toBeInTheDocument();
  const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST') ?? [];
  expect(init?.body).toBe(JSON.stringify({ kind: 'fact', description: 'never push to main', body: 'open a PR instead' }));
});

test('an entry\'s editing row holds its description and body, its origin and date, and no placeholders (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: 'editar lição m-1' }));
  expect([field(table, 'descrição'), field(table, 'corpo')].map((f) => (f as HTMLInputElement).value)).toEqual(['pnpm test runs lint, tsc and both runners', BODY_1]);
  expect(field(table, 'descrição')).not.toHaveAttribute('placeholder');
  expect(table.getByText('tarefa #812 · build · 2026-10-01')).toBeInTheDocument();
  expect(table.getByText('41 de 150 caracteres')).toBeInTheDocument();
});

test('only one row edits at a time; cancel leaves it as it was (#797)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: 'editar lição m-1' }));
  expect(field(table, 'descrição')).toHaveValue(VIEW.entries[0].description);
  await user.click(table.getByRole('button', { name: 'editar lição m-2' }));
  expect(table.getAllByRole('textbox')).toHaveLength(2); // one row: its description and its body
  expect(field(table, 'descrição')).toHaveValue('write specs in English');
  await user.click(table.getByRole('button', { name: 'cancelar' }));
  expect(table.queryByRole('textbox')).not.toBeInTheDocument();
  expect(table.getByText('write specs in English')).toBeInTheDocument();
});

test('past either limit its counter is red, its field invalid and save off; a refusal shows in the footer and the fields stay (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: '+ lição' }));
  const description = field(table, 'descrição');
  const body = field(table, 'corpo');
  await user.click(description);
  await user.paste('x'.repeat(151));
  await user.click(body);
  await user.paste('b');
  expect(table.getByText('151 de 150 caracteres')).toHaveClass('text-destructive');
  expect(description).toHaveAttribute('aria-invalid', 'true');
  expect(body).toHaveAttribute('aria-invalid', 'false');
  expect(table.getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.clear(description);
  await user.type(description, 'ok');
  await user.click(body);
  await user.paste('b'.repeat(4000));
  expect(table.getByText('4.001 de 4.000 caracteres')).toHaveClass('text-destructive');
  expect(body).toHaveAttribute('aria-invalid', 'true');
  expect(table.getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.clear(body);
  await user.type(body, 'the lesson');
  refuseWrites = true;
  await user.click(table.getByRole('button', { name: 'salvar' }));
  const alert = await table.findByRole('alert');
  expect(alert).toHaveTextContent('a memória está cheia: remova uma lição ou encurte uma descrição');
  expect(alert.parentElement).toContainElement(table.getByRole('button', { name: 'salvar' }));
  expect([(description as HTMLInputElement).value, (body as HTMLTextAreaElement).value]).toEqual(['ok', 'the lesson']);
});

test('Enter in the body breaks the line and ⌘/Ctrl+Enter saves from either field; an IME composition\'s Enter never saves (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  fireEvent.click(table.getByRole('button', { name: '+ lição' }));
  const description = field(table, 'descrição');
  const body = field(table, 'corpo');
  fireEvent.change(description, { target: { value: 'never push to main' } });
  await user.type(body, 'line one{Enter}line two');
  expect(body).toHaveValue('line one\nline two');
  expect(fireEvent.keyDown(body, { key: 'Enter' }), 'not prevented: the textarea breaks the line').toBe(true);
  fireEvent.keyDown(description, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(body, { key: 'Enter', metaKey: true, isComposing: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true }), 'default prevented').toBe(false);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});

test('Enter in the description saves (#680)', async () => {
  render(<Harness />);
  const table = lessons();
  fireEvent.click(table.getByRole('button', { name: 'editar lição m-1' }));
  expect(fireEvent.keyDown(field(table, 'descrição'), { key: 'Enter' })).toBe(false);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/workspaces/hive/memory/m-1', expect.objectContaining({ method: 'PUT' })));
});

test('✎ and + lesson focus the description; save focuses the lesson\'s description, cancel goes back to it or to + lesson (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: 'editar lição m-1' }));
  expect(field(table, 'descrição')).toHaveFocus();
  await user.click(table.getByRole('button', { name: 'cancelar' }));
  expect(table.getByRole('button', { name: 'pnpm test runs lint, tsc and both runners' })).toHaveFocus();
  await user.click(table.getByRole('button', { name: 'editar lição m-1' }));
  await user.click(table.getByRole('button', { name: 'salvar' }));
  expect(await table.findByRole('button', { name: 'pnpm test is the only gate' })).toHaveFocus();
  await user.click(table.getByRole('button', { name: '+ lição' }));
  expect(field(table, 'descrição')).toHaveFocus();
  await user.click(table.getByRole('button', { name: 'cancelar' }));
  expect(table.getByRole('button', { name: '+ lição' })).toHaveFocus();
  await user.click(table.getByRole('button', { name: '+ lição' }));
  await user.type(field(table, 'descrição'), 'never push to main');
  await user.type(field(table, 'corpo'), 'open a PR');
  await user.click(table.getByRole('button', { name: 'salvar' }));
  expect(await table.findByRole('button', { name: 'never push to main' })).toHaveFocus();
});

test('✕ focuses the next visible lesson\'s description, or + lesson when none follows (#680)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const table = lessons();
  await user.click(table.getByRole('button', { name: 'remover lição m-1' }));
  expect(await table.findByRole('button', { name: 'write specs in English' })).toHaveFocus();
  await user.click(table.getByRole('radio', { name: 'evitar · 1' }));
  await user.click(table.getByRole('button', { name: 'remover lição m-3' }));
  await waitFor(() => expect(table.getByRole('button', { name: '+ lição' })).toHaveFocus());
});

test('the table reads in English (#797)', () => {
  setLanguage('en');
  render(<Harness />);
  const table = lessons('lessons');
  expect(table.getAllByRole('radio').map((r: HTMLElement) => r.textContent)).toEqual(['all · 3', 'preference · 1', 'codebase fact · 1', 'avoid · 1']);
  expect(table.getByText(new RegExp(`^task #812 · build · 2026-10-01 · description 41 · body ${BODY_1.length} characters`))).toBeInTheDocument();
  expect(table.getByText(new RegExp(`^you · 2026-10-03 · description 24 · body ${BODY_3.length} characters`))).toBeInTheDocument();
  expect([table.getByText('cited 5 times'), table.getByText('cited 1 time')]).toHaveLength(2);
  expect(table.getByRole('button', { name: '+ lesson' })).toBeInTheDocument();
});

test('the editing row reads in English (#680)', () => {
  setLanguage('en');
  render(<Harness />);
  const table = lessons('lessons');
  fireEvent.click(table.getByRole('button', { name: '+ lesson' }));
  expect([field(table, 'description'), field(table, 'body')]).toHaveLength(2);
  expect(table.getByText('what the lesson is about, short and direct')).toBeInTheDocument();
  expect(table.getByText('the lesson, why it holds and how to apply it')).toBeInTheDocument();
  expect(table.getByText('0 of 4,000 characters')).toBeInTheDocument();
  expect(table.getByText('you · now')).toBeInTheDocument();
});
