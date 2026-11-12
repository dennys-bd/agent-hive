import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DecompositionHost } from '@/components/DecompositionDialog';
import { openDecomposition } from '@/hooks/use-decomposition-write';
import { setLanguage } from '@/i18n';
import type { DecompositionPreview } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

// The decomposition's confirm (#865): what will be written or why nothing can be, the source and column, and an error that keeps it open.
const PATH = '/activities/a-I1/decomposition';
const SOURCES = [{ name: 'board', statuses: ['Backlog', 'Goals'], column: 'Backlog' }];
const PREVIEW: DecompositionPreview = { title: 'Site for XPTO', issues: 5, blockers: 3, suggestions: 1, problems: [], warnings: [], repository: 'acme/site', sources: SOURCES };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let preview: DecompositionPreview = PREVIEW;
let answer: () => Response | Promise<Response> = () => json({ ok: true });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST' ? answer() : json(preview)));
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const create = (): HTMLElement => screen.getByRole('button', { name: 'criar issues' });
const show = (): void => { openDecomposition('a-I1', '#1'); render(<DecompositionHost />); };
const RUNNING_NOTE = 'pode fechar: a criação continua em segundo plano e as issues aparecem em tarefas ao terminar. se algo falhar, um aviso aparece.';
const TRANSIENT = 'O GitHub não respondeu. As issues já criadas ficam: clique em "criar issues" de novo para continuar de onde parou.';
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

test('preselects the only source and the first stage\'s column, says what will be written and posts the choice; a success closes it (#865)', async () => {
  const user = userEvent.setup();
  show();
  expect(await screen.findByText('5 issues, 3 bloqueios')).toBeInTheDocument();
  expect(screen.getByText('1 sugestão fica de fora')).toBeInTheDocument();
  expect(screen.getByText('acme/site')).toBeInTheDocument();
  expect(screen.getByLabelText('source')).toHaveTextContent('board');
  expect(screen.getByLabelText('coluna')).toHaveTextContent('Backlog');
  await user.click(create());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(posts()).toEqual([[PATH, expect.objectContaining({ body: JSON.stringify({ source: 'board', column: 'Backlog' }) })]]);
});

test('shows each problem with its line and keeps criar issues disabled (#865)', async () => {
  preview = { issues: 0, blockers: 0, suggestions: 0, problems: [{ line: 31, message: 'a leaf needs "### Acceptance criteria"' }], warnings: [], repository: 'acme/site', sources: SOURCES };
  show();
  expect(await screen.findByText('linha 31: a leaf needs "### Acceptance criteria"')).toBeInTheDocument();
  expect(create()).toBeDisabled();
});

test('a local goal whose workspace has no GitHub origin says so and keeps criar issues disabled (#865)', async () => {
  preview = { title: 'Site for XPTO', issues: 6, blockers: 3, suggestions: 0, problems: [], warnings: [], sources: SOURCES };
  show();
  expect(await screen.findByText('O workspace não tem origin no GitHub: não há onde criar as issues.')).toBeInTheDocument();
  expect(create()).toBeDisabled();
});

test('without a GitHub source it says so and keeps criar issues disabled (#865)', async () => {
  preview = { ...PREVIEW, sources: [] };
  show();
  expect(await screen.findByText('Nenhuma fonte GitHub para criar as issues.')).toBeInTheDocument();
  expect(create()).toBeDisabled();
});

test('a failed write shows GitHub\'s words and the recovery sentence inline, fires no toast and stays open; a second press posts again (#865, #781)', async () => {
  const user = userEvent.setup();
  answer = () => json({ error: 'was submitted too quickly' }, 502);
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  await user.click(create());
  expect(await screen.findByRole('alert')).toHaveTextContent('was submitted too quickly. As issues já criadas ficam: clique em "criar issues" de novo para continuar de onde parou.');
  expect(toast.error).not.toHaveBeenCalled();
  await waitFor(() => expect(create()).toBeEnabled());
  await user.click(create());
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('a write that gave up on a transient GitHub error shows the copy that a second press resumes, not gh\'s words (#702)', async () => {
  const user = userEvent.setup();
  answer = () => json({ error: 'stream error: stream ID 5; REFUSED_STREAM', code: 'transient' }, 502);
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  await user.click(create());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('O GitHub não respondeu. As issues já criadas ficam: clique em "criar issues" de novo para continuar de onde parou.');
  expect(alert).not.toHaveTextContent('REFUSED_STREAM');
  await waitFor(() => expect(create()).toBeEnabled());
});

test('lists each overlap under the counts, muted, and keeps criar issues enabled (#936)', async () => {
  const message = '"2.1" touches "src/contact.ts" and "2.2" touches "src", and no "Blocked by:" orders them';
  preview = { ...PREVIEW, warnings: [{ line: 76, message }] };
  show();
  const item = await screen.findByText(`linha 76: ${message}`);
  expect(screen.getByText('Nós que tocam os mesmos arquivos sem bloqueio entre eles (as issues são criadas mesmo assim):')).toBeInTheDocument();
  expect(item.closest('div')).toHaveClass('text-muted-foreground');
  expect(create()).toBeEnabled();
});

test('shows where the file is pushed, repository, branch and path, under the repository line (#936)', async () => {
  preview = { ...PREVIEW, delivery: { repository: 'acme/docs', branch: 'hive/7-site', path: 'agent/specs/site-decomposition.md' } };
  show();
  const line = await screen.findByText('acme/docs · hive/7-site · agent/specs/site-decomposition.md');
  expect(line).toHaveClass('font-mono');
  expect(screen.getByText('entrega')).toHaveClass('text-muted-foreground');
  expect(create()).toBeEnabled();
});

test('a file git ignores stays local: the row says so with its path, muted, no delivery line, and criar issues stays enabled (#741)', async () => {
  preview = { ...PREVIEW, delivery: { repository: 'acme/docs', branch: 'main', path: 'docs/hive/specs/site-decomposition.md', local: true } };
  show();
  expect(await screen.findByText('o arquivo fica local · docs/hive/specs/site-decomposition.md')).toHaveClass('text-muted-foreground');
  expect(screen.queryByText('entrega')).not.toBeInTheDocument();
  expect(screen.queryByText('acme/docs · main · docs/hive/specs/site-decomposition.md')).not.toBeInTheDocument();
  expect(create()).toBeEnabled();
});

test('a delivery that cannot go says why and keeps criar issues disabled (#936)', async () => {
  const reason = 'the decomposition file\'s checkout is on acme/docs\'s default branch (main): the Hive never pushes it';
  preview = { ...PREVIEW, delivery: { repository: 'acme/docs', branch: 'main', path: 'a.md' }, deliveryRefusal: reason };
  show();
  expect(await screen.findByText(reason)).toHaveClass('text-destructive');
  expect(create()).toBeDisabled();
});

test('a refusal that wrote nothing shows the server\'s words alone (#781)', async () => {
  const user = userEvent.setup();
  answer = () => json({ error: 'as issues desta decomposição já estão sendo criadas' }, 409);
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  await user.click(create());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('as issues desta decomposição já estão sendo criadas');
  expect(alert).not.toHaveTextContent('As issues já criadas ficam');
  await waitFor(() => expect(create()).toBeEnabled());
});

test('pressing criar issues shows the running state: pickers disabled, fechar, the busy primary, the note in its status region, aria-busy (#781)', async () => {
  const user = userEvent.setup();
  const release = held(() => json({ ok: true }));
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  const note = screen.getByRole('status');
  expect(note).toBeEmptyDOMElement();
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
  await user.click(create());
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByLabelText('source')).toBeDisabled();
  expect(screen.getByLabelText('coluna')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'cancelar' })).toBeNull();
  expect(screen.getByRole('button', { name: 'fechar' })).toHaveTextContent('fecharesc');
  expect(screen.getByRole('button', { name: 'criando issues…' })).toBeDisabled();
  expect(screen.getByTestId('spinner')).toBeInTheDocument();
  expect(screen.getByRole('status')).toBe(note); // the same node from the open, so a screen reader announces the change
  expect(note).toHaveTextContent(RUNNING_NOTE);
  await act(async () => { release(); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('fechar while the write runs sends nothing; reopened, the dialog shows the running state with no second press, and the success shows nothing (#781)', async () => {
  const user = userEvent.setup();
  const release = held(() => json({ ok: true }));
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  await user.click(create());
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => openDecomposition('a-I1', '#1'));
  expect(await screen.findByRole('button', { name: 'criando issues…' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'criar issues' })).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent(RUNNING_NOTE);
  await act(async () => { release(); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(posts()).toHaveLength(1);
  expect(toast.error).not.toHaveBeenCalled();
});

test('a write that fails after esc closed the dialog toasts once; reabrir opens it with that error inline and criar issues enabled (#781)', async () => {
  const user = userEvent.setup();
  const fail = held(() => json({ error: 'stream error: REFUSED_STREAM', code: 'transient' }, 502));
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  await user.click(create());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await act(async () => { fail(); });
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  const [title, options] = vi.mocked(toast.error).mock.calls[0]!;
  expect([title, options?.description]).toEqual(['A criação das issues de #1 parou', TRANSIENT]);
  act(() => (options as unknown as { action: { onClick(): void } }).action.onClick());
  expect(await screen.findByRole('alert')).toHaveTextContent(TRANSIENT);
  await waitFor(() => expect(create()).toBeEnabled());
});

test('the confirm shortcut writes once while criar issues is enabled, and the hint shows on the primary; with a problem it posts nothing (#781)', async () => {
  const user = userEvent.setup();
  show();
  await screen.findByText('5 issues, 3 bloqueios');
  expect(create()).toHaveTextContent(/criar issues.+/);
  await user.keyboard('{Control>}{Enter}{/Control}'); // confirm, Ctrl+Enter off macOS (#585)
  await waitFor(() => expect(posts()).toHaveLength(1));
});

test('the confirm shortcut posts nothing while the preview has a problem (#781)', async () => {
  const user = userEvent.setup();
  preview = { ...PREVIEW, issues: 0, problems: [{ line: 3, message: 'x' }] };
  show();
  await screen.findByText('linha 3: x');
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(posts()).toEqual([]);
});
