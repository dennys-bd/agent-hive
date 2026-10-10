import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DecompositionDialog } from '@/components/DecompositionDialog';
import { setLanguage } from '@/i18n';
import type { DecompositionPreview } from '../../src/types';

// The decomposition's confirm (#865): what will be written or why nothing can be, the source and column, and an error that keeps it open.
const PATH = '/activities/a-I1/decomposition';
const SOURCES = [{ name: 'board', statuses: ['Backlog', 'Goals'], column: 'Backlog' }];
const PREVIEW: DecompositionPreview = { title: 'Site for XPTO', issues: 5, blockers: 3, suggestions: 1, problems: [], repository: 'acme/site', sources: SOURCES };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let preview: DecompositionPreview = PREVIEW;
let answer: () => Response = () => json({ ok: true });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST' ? answer() : json(preview)));
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const create = (): HTMLElement => screen.getByRole('button', { name: 'criar issues' });

beforeEach(() => {
  setLanguage('pt');
  preview = PREVIEW;
  answer = () => json({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('preselects the only source and the first stage\'s column, says what will be written and posts the choice; a success closes it (#865)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<DecompositionDialog activityId="a-I1" onClose={onClose} />);
  expect(await screen.findByText('5 issues, 3 bloqueios')).toBeInTheDocument();
  expect(screen.getByText('1 sugestão fica de fora')).toBeInTheDocument();
  expect(screen.getByText('acme/site')).toBeInTheDocument();
  expect(screen.getByLabelText('source')).toHaveTextContent('board');
  expect(screen.getByLabelText('coluna')).toHaveTextContent('Backlog');
  await user.click(create());
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([[PATH, expect.objectContaining({ body: JSON.stringify({ source: 'board', column: 'Backlog' }) })]]);
});

test('shows each problem with its line and keeps criar issues disabled (#865)', async () => {
  preview = { issues: 0, blockers: 0, suggestions: 0, problems: [{ line: 31, message: 'a leaf needs "### Acceptance criteria"' }], repository: 'acme/site', sources: SOURCES };
  render(<DecompositionDialog activityId="a-I1" onClose={vi.fn()} />);
  expect(await screen.findByText('linha 31: a leaf needs "### Acceptance criteria"')).toBeInTheDocument();
  expect(create()).toBeDisabled();
});

test('a local goal whose workspace has no GitHub origin says so and keeps criar issues disabled (#865)', async () => {
  preview = { title: 'Site for XPTO', issues: 6, blockers: 3, suggestions: 0, problems: [], sources: SOURCES };
  render(<DecompositionDialog activityId="a-I1" onClose={vi.fn()} />);
  expect(await screen.findByText('O workspace não tem origin no GitHub: não há onde criar as issues.')).toBeInTheDocument();
  expect(create()).toBeDisabled();
});

test('without a GitHub source it says so and keeps criar issues disabled (#865)', async () => {
  preview = { ...PREVIEW, sources: [] };
  render(<DecompositionDialog activityId="a-I1" onClose={vi.fn()} />);
  expect(await screen.findByText('Nenhuma fonte GitHub para criar as issues.')).toBeInTheDocument();
  expect(create()).toBeDisabled();
});

test('a failed write shows GitHub\'s message inline and stays open; a second press posts again (#865)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  answer = () => json({ error: 'was submitted too quickly' }, 502);
  render(<DecompositionDialog activityId="a-I1" onClose={onClose} />);
  await screen.findByText('5 issues, 3 bloqueios');
  await user.click(create());
  expect(await screen.findByRole('alert')).toHaveTextContent('was submitted too quickly');
  await waitFor(() => expect(create()).toBeEnabled());
  await user.click(create());
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(onClose).not.toHaveBeenCalled();
});
