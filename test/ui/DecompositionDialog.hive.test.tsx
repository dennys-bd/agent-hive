import { render, screen } from '@testing-library/react';
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
const SOURCES = [{ name: 'board', statuses: ['Backlog', 'Goals'], column: 'Backlog' }];
const GITHUB_ONLY: DecompositionPreview = { title: 'Site for XPTO', issues: 5, blockers: 3, suggestions: 0, problems: [], warnings: [], repository: 'acme/site', sources: SOURCES };
const PREVIEW: DecompositionPreview = { ...GITHUB_ONLY, hive: HIVE };
const PRESELECTED: DecompositionPreview = { ...PREVIEW, hive: { ...HIVE, preselected: true } };
const NO_SOURCE = 'Nenhuma fonte GitHub para criar as issues.';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let preview: DecompositionPreview = PREVIEW;
let answer: () => Response | Promise<Response> = () => json({ ok: true });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST' ? answer() : json(preview)));
const show = (): void => { openDecomposition('a-I1', 'HIVE-1'); render(<DecompositionHost />); };
type User = ReturnType<typeof userEvent.setup>;
// Opens a picker and answers its options' labels, left open so the test picks one
async function optionsOf(user: User, picker: string): Promise<string[]> {
  await user.click(screen.getByRole('combobox', { name: picker }));
  return (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
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
