import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DecompositionHost } from '@/components/DecompositionDialog';
import { openDecomposition } from '@/hooks/use-decomposition-write';
import { setLanguage } from '@/i18n';
import type { DecompositionHive, DecompositionPreview, TaskEntry } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

// The decomposition dialog's hive variant (#784): the hive offered first, its own words, rows and entra em, its gate and its write. A preview
// with no hive is DecompositionDialog.test.tsx's, unchanged.
const ENTRIES: TaskEntry[] = [null, { flow: 'main' }, { flow: 'main', stage: 'goal' }, { flow: 'main', stage: 'spec' }, { flow: 'other' }, { flow: 'other', stage: 'build' }];
const HIVE: DecompositionHive = { entries: ENTRIES, entry: { flow: 'main' }, tasks: 4, delivery: { path: 'docs/site-decomposition.md', local: true } };
const PATH = '/activities/a-I1/decomposition';
const SOURCES = [{ name: 'board', statuses: ['Backlog', 'Goals'], column: 'Backlog' }];
const GITHUB_ONLY: DecompositionPreview = { title: 'Site for XPTO', issues: 5, blockers: 3, suggestions: 0, problems: [], warnings: [], repository: 'acme/site', sources: SOURCES };
const PREVIEW: DecompositionPreview = { ...GITHUB_ONLY, hive: HIVE };
const PRESELECTED: DecompositionPreview = { ...PREVIEW, hive: { ...HIVE, preselected: true } };
const NO_SOURCE = 'Nenhuma fonte GitHub para criar as issues.';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let preview: DecompositionPreview = PREVIEW;
let answer: () => Response | Promise<Response> = () => json({ ok: true });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST' ? answer() : json(preview)));
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const show = (): void => { openDecomposition('a-I1', 'HIVE-1'); render(<DecompositionHost />); };
type User = ReturnType<typeof userEvent.setup>;
// Opens a picker and answers its options' labels, left open so the test picks one
async function optionsOf(user: User, picker: string): Promise<string[]> {
  await user.click(screen.getByRole('combobox', { name: picker }));
  return (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
}
const createTasks = (): HTMLElement => screen.getByRole('button', { name: 'criar tarefas' });
const createIssues = (): HTMLElement => screen.getByRole('button', { name: 'criar issues' });
const RUNNING_HIVE = 'pode fechar: a criação continua em segundo plano e as tarefas aparecem no fluxo ao terminar. se algo falhar, um aviso aparece.';
// A POST that answers only when the test lets it, so the running state can be read
function held(response: () => Response): () => void {
  let release = (): void => undefined;
  answer = () => new Promise((resolve) => { release = () => resolve(response()); });
  return () => release();
}

beforeEach(() => {
  setLanguage('pt');
  preview = PREVIEW;
  answer = () => json({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('a GitHub goal opens on its own source and the picker lists the hive first; choosing it shows Criar tarefas, the tasks count, entra em, the hive\'s delivery and no repository row (#784)', async () => {
  const user = userEvent.setup();
  show();
  expect(await screen.findByRole('dialog', { name: 'Criar issues' })).toBeInTheDocument();
  expect(screen.getByLabelText('source')).toHaveTextContent('board');
  expect(await optionsOf(user, 'source')).toEqual(['hive', 'board']);
  await user.click(screen.getByRole('option', { name: 'hive' }));
  expect(await screen.findByRole('dialog', { name: 'Criar tarefas' })).toBeInTheDocument();
  expect(screen.getByText('4 tarefas, 3 bloqueios')).toBeInTheDocument();
  expect(screen.getByLabelText('entra em')).toHaveTextContent('main');
  expect(screen.queryByLabelText('coluna')).toBeNull();
  expect(screen.queryByText('acme/site')).toBeNull();
  expect(screen.getByText('o arquivo fica local · docs/site-decomposition.md')).toHaveClass('text-muted-foreground');
});

test('a hive goal (preselected) opens with the hive chosen (#784)', async () => {
  preview = PRESELECTED;
  show();
  expect(await screen.findByRole('dialog', { name: 'Criar tarefas' })).toBeInTheDocument();
  expect(screen.getByLabelText('source')).toHaveTextContent('hive');
});

test('with no GitHub source the hive opens chosen and noSource does not show (#784)', async () => {
  preview = { ...PREVIEW, sources: [] };
  show();
  expect(await screen.findByRole('dialog', { name: 'Criar tarefas' })).toBeInTheDocument();
  expect(screen.getByLabelText('source')).toHaveTextContent('hive');
  expect(screen.queryByText(NO_SOURCE)).toBeNull();
});

test('a recorded hive target opens on the hive with the source picker disabled (#784)', async () => {
  preview = { ...PREVIEW, target: 'hive' };
  show();
  expect(await screen.findByRole('dialog', { name: 'Criar tarefas' })).toBeInTheDocument();
  expect(screen.getByLabelText('source')).toHaveTextContent('hive');
  expect(screen.getByLabelText('source')).toBeDisabled();
});

test('a recorded hive target with the hive gone shows noSource and keeps the create button disabled (#784)', async () => {
  preview = { ...GITHUB_ONLY, target: 'hive' };
  show();
  expect(await screen.findByText(NO_SOURCE)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'criar issues' })).toBeDisabled();
});

test('entra em lists sem fluxo, each flow and its later stages, without the first stage\'s duplicate, with the suggested entry chosen (#784)', async () => {
  const user = userEvent.setup();
  preview = PRESELECTED;
  show();
  expect(await screen.findByLabelText('entra em')).toHaveTextContent('main');
  expect(await optionsOf(user, 'entra em')).toEqual(['sem fluxo', 'main', 'main · spec', 'other']);
  await user.click(screen.getByRole('option', { name: 'sem fluxo' }));
  expect(screen.getByLabelText('entra em')).toHaveTextContent('sem fluxo');
});

test('a top-level deliveryRefusal with none in hive leaves criar tarefas enabled under the hive and disables criar issues under a GitHub source (#784)', async () => {
  const user = userEvent.setup();
  const refusal = 'the decomposition file is in no git checkout';
  preview = { ...PRESELECTED, deliveryRefusal: refusal };
  show();
  await screen.findByRole('dialog', { name: 'Criar tarefas' });
  expect(createTasks()).toBeEnabled();
  expect(screen.queryByText(refusal)).toBeNull();
  await optionsOf(user, 'source');
  await user.click(screen.getByRole('option', { name: 'board' }));
  expect(await screen.findByText(refusal)).toHaveClass('text-destructive');
  expect(createIssues()).toBeDisabled();
});

test.each([
  { refusal: 'a task already holds this goal\'s issue as its origin' },
  { deliveryRefusal: 'the decomposition file\'s checkout is on acme/docs\'s default branch (main): the Hive never pushes it' },
])('the hive\'s own refusal %o shows its words and disables criar tarefas; a GitHub source stays choosable (#784)', async (extra) => {
  const user = userEvent.setup();
  preview = { ...PREVIEW, hive: { ...HIVE, preselected: true, ...extra } };
  show();
  expect(await screen.findByText(Object.values(extra)[0]!)).toHaveClass('text-destructive');
  expect(createTasks()).toBeDisabled();
  await optionsOf(user, 'source');
  await user.click(screen.getByRole('option', { name: 'board' }));
  expect(createIssues()).toBeEnabled();
});

test('criar tarefas posts the hive and the suggested entry; while it runs the primary reads criando tarefas…, entra em is disabled and the note is the hive\'s (#784)', async () => {
  const user = userEvent.setup();
  const release = held(() => json({ ok: true }));
  preview = PRESELECTED;
  show();
  await screen.findByRole('dialog', { name: 'Criar tarefas' });
  await user.click(createTasks());
  expect(screen.getByRole('button', { name: 'criando tarefas…' })).toBeDisabled();
  expect(screen.getByLabelText('entra em')).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent(RUNNING_HIVE);
  await waitFor(() => expect(posts()).toEqual([[PATH, expect.objectContaining({ body: JSON.stringify({ source: 'hive', entry: { flow: 'main' } }) })]]));
  await act(async () => { release(); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('under sem fluxo criar tarefas posts entry null (#784)', async () => {
  const user = userEvent.setup();
  preview = PRESELECTED;
  show();
  await screen.findByRole('dialog', { name: 'Criar tarefas' });
  await optionsOf(user, 'entra em');
  await user.click(screen.getByRole('option', { name: 'sem fluxo' }));
  await user.click(createTasks());
  await waitFor(() => expect(posts()).toEqual([[PATH, expect.objectContaining({ body: JSON.stringify({ source: 'hive', entry: null }) })]]));
});
