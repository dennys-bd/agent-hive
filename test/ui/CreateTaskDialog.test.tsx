import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { setLanguage } from '@/i18n';
import { type CreateTargets, CreateTargetsContext, HIVE_ONLY } from '@/lib/create-targets';
import type { Flow, Stage } from '../../src/types';
import { mainFlows } from '../fixtures/main-flow.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }));

const stages: Stage[] = [{ name: 'backlog', from: { board: ['Todo'] }, prompt: 'x' }, { name: 'dev', from: { board: ['Doing'] }, prompt: 'x' }];
const bug: Stage = { name: 'triage', from: {}, prompt: 'x' };
const flows = [...mainFlows(stages), { name: 'bug', stages: [bug], transitions: [] }];
const state = { workspaces: ['hive', 'site'], flows, sourceWorkspaces: { work: 'site' } };
// #772: two GitHub sources with a repository for new issues; work's default workspace is site
const TARGETS: CreateTargets = { hiveSource: true, createIn: 'hive', sources: [{ name: 'work', type: 'github', repository: 'acme/app' }, { name: 'docs', type: 'github', repository: 'acme/docs' }] };

let settle: (res: Response) => void = () => undefined;
const pending = (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { settle = resolve; });
const fetchMock = vi.fn(pending);
const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (): unknown => JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
const onClose = vi.fn();
const onOpenTask = vi.fn();
interface OpenProps { title?: string; workspace?: string; source?: string; targets?: CreateTargets; flows?: Flow[] }
// no targets: HIVE_ONLY, the context's default, which #771's tests ran under
const open = ({ targets = HIVE_ONLY, flows: shown = flows, ...props }: OpenProps = {}) => render(
  <CreateTargetsContext.Provider value={targets}>
    <CreateTaskDialog state={{ ...state, flows: shown }} onClose={onClose} onOpenTask={onOpenTask} {...props} />
  </CreateTargetsContext.Provider>,
);
const cta = () => screen.getByRole('button', { name: 'criar tarefa' });
const destination = (name: string) => screen.getByRole('radio', { name });

const OPTIONS: Readonly<Record<string, { statuses: string[]; labels: string[] }>> = {
  work: { statuses: ['Backlog', 'Ready'], labels: ['bug', 'docs', 'enhancement'] },
  docs: { statuses: ['Todo'], labels: ['bug'] },
};
// GET /sources/:name/create-options answers OPTIONS at once (getJson passes no init); every POST still waits for settle
const serve = (): void => {
  fetchMock.mockImplementation((input, init) => {
    const name = /^\/sources\/(\w+)\/create-options$/.exec(String(input))?.[1];
    return name === undefined || init !== undefined ? pending(input, init) : Promise.resolve(json(OPTIONS[name], 200));
  });
};
const optionReads = () => fetchMock.mock.calls.filter(([, init]) => init === undefined).map(([url]) => String(url));
const statusBox = () => screen.getByRole('combobox', { name: /status/ });
const pick = async (user: ReturnType<typeof userEvent.setup>, box: string | RegExp, option: string) => {
  await user.click(screen.getByRole('combobox', { name: box }));
  await user.click(await screen.findByRole('option', { name: option }));
};

beforeEach(() => {
  setLanguage('pt'); onClose.mockClear(); onOpenTask.mockClear(); vi.mocked(toast).mockClear(); vi.mocked(toast.info).mockClear();
  fetchMock.mockClear(); fetchMock.mockImplementation(pending);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('opens with the title and workspace given, the title focused and the workspace marked current', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'site' });
  expect(screen.getByText('Criar tarefa')).toBeInTheDocument();
  expect(screen.getByText('só cria a tarefa, sem iniciar atividade')).toBeInTheDocument();
  const title = screen.getByLabelText('título');
  expect(title).toHaveValue('Fix login');
  await waitFor(() => expect(title).toHaveFocus());
  await user.click(screen.getByRole('combobox', { name: 'workspace' }));
  expect(await screen.findByRole('option', { name: /site.*atual/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'hive' })).toBeInTheDocument();
});

test('posts the hive task with no stage under sem fluxo, auto off, and starts nothing else', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'site' });
  await user.type(screen.getByLabelText('descrição'), 'steps');
  await user.click(cta());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0][0]).toBe('/tasks');
  expect(bodyOf()).toEqual({ title: 'Fix login', body: 'steps', source: 'hive', workspace: 'site', auto: false });
});

test('lists every flow with its stages and posts the picked stage', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'site' });
  await user.click(screen.getByRole('combobox', { name: /etapa/ }));
  expect(await screen.findByRole('option', { name: /sem fluxo/ })).toBeInTheDocument();
  expect(screen.getByText('bug')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'triage' })).toBeInTheDocument();
  await user.click(screen.getByRole('option', { name: 'dev' }));
  await user.click(cta());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(bodyOf()).toEqual({ title: 'Fix login', body: '', source: 'hive', workspace: 'site', auto: false, stage: 'dev' });
});

test('the CTA is disabled with an empty title and with no workspace until one is picked', async () => {
  const user = userEvent.setup();
  open();
  expect(screen.getByText('escolha um workspace')).toBeInTheDocument();
  await user.type(screen.getByLabelText('título'), '   ');
  expect(cta()).toBeDisabled();
  await user.type(screen.getByLabelText('título'), 'Fix');
  expect(cta()).toBeDisabled();
  await user.click(screen.getByRole('combobox', { name: 'workspace' }));
  await user.click(await screen.findByRole('option', { name: 'hive' }));
  expect(cta()).toBeEnabled();
});

test('success closes the dialog and toasts the workspace and sem fluxo, with an open action for the task', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'site' });
  await user.click(cta());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(cta()).toBeDisabled(); // busy while the request runs
  settle(json({ id: 'HIVE-1', itemId: 'local:1' }, 201));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  const [message, options] = vi.mocked(toast).mock.calls[0] as [string, { action: { label: string; onClick(): void } }];
  expect(message).toBe('Tarefa criada em site · sem fluxo');
  expect(options.action.label).toBe('abrir');
  options.action.onClick();
  expect(onOpenTask).toHaveBeenCalledWith('HIVE-1');
});

test('the toast names the picked stage (English)', async () => {
  const user = userEvent.setup();
  setLanguage('en');
  open({ title: 'Fix login', workspace: 'site' });
  await user.click(screen.getByRole('combobox', { name: /stage/ }));
  await user.click(await screen.findByRole('option', { name: 'dev' }));
  await user.click(screen.getByRole('button', { name: 'create task' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  settle(json({ id: 'HIVE-2', itemId: 'local:2' }, 201));
  await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Task created in site · dev', expect.anything()));
});

test('a refusal keeps the dialog open with the message and every field as typed', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'site' });
  await user.type(screen.getByLabelText('descrição'), 'steps');
  await user.click(cta());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  settle(json({ error: 'no such workspace' }, 400));
  expect(await screen.findByRole('alert')).toHaveTextContent('no such workspace');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('título')).toHaveValue('Fix login');
  expect(screen.getByLabelText('descrição')).toHaveValue('steps');
  expect(cta()).toBeEnabled();
  await user.type(screen.getByLabelText('título'), '!');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a second Enter while the request runs posts nothing more', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'site' });
  await user.type(screen.getByLabelText('título'), '{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  await user.type(screen.getByLabelText('título'), '{Enter}');
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('a workspace the Comb no longer has comes unpicked, and the CTA waits for a pick', () => {
  open({ title: 'Fix login', workspace: 'gone' });
  expect(screen.getByText('escolha um workspace')).toBeInTheDocument();
  expect(cta()).toBeDisabled();
});

test('criar em comes preselected by where the dialog opened, and the hint shows only when the workspace picked the source (#772)', () => {
  const hint = 'o workspace site tem uma source GitHub, por isso a issue vem marcada.';
  const cases: [OpenProps, string, boolean][] = [
    [{ workspace: 'site' }, 'issue no GitHub', true],
    [{ workspace: 'hive' }, 'hive', false],
    [{ workspace: 'site', source: 'docs' }, 'issue no GitHub', false],
    [{ workspace: 'site', source: 'hive' }, 'hive', false],
    [{ targets: { ...TARGETS, createIn: 'docs' } }, 'issue no GitHub', false],
  ];
  for (const [props, picked, isHinted] of cases) {
    const { unmount } = open({ title: 'Fix', targets: TARGETS, ...props });
    expect(destination(picked), JSON.stringify(props)).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(hint) !== null, JSON.stringify(props)).toBe(isHinted);
    unmount();
  }
});

test('a destination that is not available stays visible, disabled, with its reason (#772)', () => {
  const { unmount } = open({ title: 'Fix', workspace: 'site' }); // HIVE_ONLY: no source has a repository
  expect(destination('issue no GitHub')).toBeDisabled();
  expect(screen.getByText('nenhuma source GitHub tem repositório para novas issues')).toBeInTheDocument();
  unmount();
  open({ title: 'Fix', targets: { ...TARGETS, hiveSource: false, createIn: 'work' } });
  expect(destination('hive')).toBeDisabled();
  expect(destination('issue no GitHub')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('o hive está desligado')).toBeInTheDocument();
});

test('switching destination keeps every field, and the CTA follows it (#772)', async () => {
  const user = userEvent.setup();
  open({ title: 'Fix login', workspace: 'hive', targets: TARGETS });
  await user.type(screen.getByLabelText('descrição'), 'steps');
  await user.click(destination('issue no GitHub'));
  expect(screen.getByRole('button', { name: 'criar issue' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'workspace' })).not.toBeInTheDocument();
  await user.click(destination('hive'));
  expect(screen.getByLabelText('título')).toHaveValue('Fix login');
  expect(screen.getByLabelText('descrição')).toHaveValue('steps');
  expect(cta()).toBeEnabled(); // the workspace it opened in is still picked
});

test('hive reads no create options; issue no GitHub reads its repository\'s once, back and forth included (#772)', async () => {
  const user = userEvent.setup();
  serve();
  open({ title: 'Fix', workspace: 'hive', targets: TARGETS });
  expect(optionReads()).toEqual([]);
  await user.click(destination('issue no GitHub'));
  await waitFor(() => expect(statusBox()).toHaveTextContent('Backlog'));
  await user.click(destination('hive'));
  await user.click(destination('issue no GitHub'));
  expect(statusBox()).toHaveTextContent('Backlog');
  expect(optionReads()).toEqual(['/sources/work/create-options']);
});

test('opened with a source, its repository comes picked (#772)', () => {
  open({ title: 'Fix', source: 'docs', targets: TARGETS });
  expect(screen.getByRole('combobox', { name: 'repositório' })).toHaveTextContent('acme/docs');
});

test('each repository picked is read once, its status starts on its first option, and a source picked again starts over (#772)', async () => {
  const user = userEvent.setup();
  serve();
  open({ title: 'Fix', workspace: 'site', targets: TARGETS });
  await waitFor(() => expect(statusBox()).toHaveTextContent('Backlog'));
  await pick(user, /status/, 'Ready');
  await pick(user, 'repositório', 'acme/docs');
  await waitFor(() => expect(statusBox()).toHaveTextContent('Todo'));
  await pick(user, 'repositório', 'acme/app');
  expect(statusBox()).toHaveTextContent('Backlog');
  expect(optionReads()).toEqual(['/sources/work/create-options', '/sources/docs/create-options']);
});

test('while the options load, status and labels are disabled and read carregando…; a failure shows its retry line, not the server\'s words, and criar issue waits (#772)', async () => {
  const user = userEvent.setup();
  let answer: (res: Response) => void = () => undefined;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
  open({ title: 'Fix', workspace: 'site', targets: TARGETS });
  expect(statusBox()).toBeDisabled();
  expect(statusBox()).toHaveTextContent('carregando…');
  expect(screen.getByRole('button', { name: 'carregando…' })).toBeDisabled();
  answer(json({ error: 'Bad credentials' }, 502));
  expect(await screen.findByText(/não deu para ler os status e as labels de acme\/app\./)).toBeInTheDocument();
  expect(screen.queryByText(/Bad credentials/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'criar issue' })).toBeDisabled();
  serve();
  await user.click(screen.getByRole('button', { name: 'tentar de novo' }));
  await waitFor(() => expect(statusBox()).toHaveTextContent('Backlog'));
  expect(screen.getByRole('button', { name: 'criar issue' })).toBeEnabled();
});

test('a label picked becomes a chip, + label leaves out what was picked, a new repository drops the labels it lacks, and × removes one (#772)', async () => {
  const user = userEvent.setup();
  serve();
  open({ title: 'Fix', workspace: 'site', targets: TARGETS });
  for (const label of ['docs', 'bug']) {
    await user.click(await screen.findByRole('button', { name: 'label' }));
    await user.click(await screen.findByRole('menuitem', { name: label }));
  }
  await user.click(screen.getByRole('button', { name: 'label' }));
  expect(screen.queryByRole('menuitem', { name: 'docs' })).not.toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'enhancement' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await pick(user, 'repositório', 'acme/docs');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'tirar docs' })).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'tirar bug' }));
  expect(screen.queryByRole('button', { name: /^tirar / })).not.toBeInTheDocument();
});

const REF = { id: '912', url: 'https://github.com/acme/app/issues/912' };
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)) as unknown);
type Before = (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
// opens under issue no GitHub (work, by the workspace), runs before, posts, and answers the POST with answer
async function answered(answer: unknown, { flows: shown, before }: { flows?: Flow[]; before?: Before } = {}) {
  const user = userEvent.setup();
  serve();
  const view = open({ title: 'Fix', workspace: 'site', targets: TARGETS, flows: shown });
  await waitFor(() => expect(statusBox()).toBeEnabled());
  await before?.(user);
  await user.click(screen.getByRole('button', { name: 'criar issue' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  settle(json(answer, 201));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  return view;
}

test('criar issue posts title, body, source, labels and status, never workspace, stage or auto, status null under fora do project, and reads criando issue… while it runs (#772)', async () => {
  const user = userEvent.setup();
  serve();
  open({ title: 'Fix login', workspace: 'site', targets: TARGETS });
  await waitFor(() => expect(statusBox()).toBeEnabled());
  await user.type(screen.getByLabelText('descrição'), 'steps');
  await pick(user, /status/, 'fora do project');
  await user.click(screen.getByRole('button', { name: 'label' }));
  await user.click(await screen.findByRole('menuitem', { name: 'bug' }));
  await user.click(screen.getByRole('button', { name: 'criar issue' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toEqual({ title: 'Fix login', body: 'steps', source: 'work', labels: ['bug'], status: null });
  expect(screen.getByRole('button', { name: 'criando issue…' })).toBeDisabled();
});

test('an issue in the flow toasts its stage with one flow, flow · stage with two, sem fluxo with no stage, and abrir opens it (#772)', async () => {
  const cases: [Record<string, unknown>, Flow[], string][] = [
    [{ stage: 'dev' }, mainFlows(stages), 'Issue #912 criada · entra em dev'],
    [{ stage: 'triage' }, flows, 'Issue #912 criada · entra em bug · triage'],
    [{}, flows, 'Issue #912 criada · em tarefas › sem fluxo'],
  ];
  for (const [extra, shown, message] of cases) {
    vi.mocked(toast).mockClear(); onClose.mockClear(); fetchMock.mockClear();
    const { unmount } = await answered({ id: 'APP-7', itemId: 'gh:1', ref: REF, ...extra }, { flows: shown });
    expect(posts()[0]).toEqual({ title: 'Fix', body: '', source: 'work', labels: [], status: 'Backlog' });
    const [text, options] = vi.mocked(toast).mock.calls[0] as [string, { action: { label: string; onClick(): void } }];
    expect([text, options.action.label]).toEqual([message, 'abrir']);
    options.action.onClick();
    expect(onOpenTask).toHaveBeenLastCalledWith('APP-7');
    unmount();
  }
});

test('a notice toasts that the issue is still outside the hive, with ver no GitHub, and the off-Project line under fora do project (#772)', async () => {
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
  const cases: [Before | undefined, string][] = [
    [undefined, 'Nenhuma source pega a issue. Ela aparece quando passar no filtro de uma source.'],
    [(user) => pick(user, /status/, 'fora do project'), 'Fora do project, nenhuma source a lista.'],
  ];
  for (const [before, line] of cases) {
    vi.mocked(toast.info).mockClear(); onClose.mockClear(); fetchMock.mockClear();
    const { unmount } = await answered({ ref: { ...REF, id: '88' }, notice: 'created off the Project' }, { before });
    const [text, options] = vi.mocked(toast.info).mock.calls[0] as [string, { description: string; action: { label: string; onClick(): void } }];
    expect([text, options.description, options.action.label]).toEqual(['Issue #88 criada, ainda fora do hive', line, 'ver no GitHub']);
    options.action.onClick();
    expect(opened).toHaveBeenLastCalledWith(REF.url, '_blank', 'noreferrer');
    unmount();
  }
  expect(vi.mocked(toast)).not.toHaveBeenCalled();
});

// opens under issue no GitHub, types a description, posts, and answers the POST with a refusal
async function refused(answer: unknown, status: number) {
  const user = userEvent.setup();
  serve();
  open({ title: 'Fix login', workspace: 'site', targets: TARGETS });
  await waitFor(() => expect(statusBox()).toBeEnabled());
  await user.type(screen.getByLabelText('descrição'), 'steps');
  await user.click(screen.getByRole('button', { name: 'criar issue' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  settle(json(answer, status));
  await screen.findByRole('alert');
  return user;
}
const FAILED = 'não deu para criar a issue em acme/app: o GitHub falhou. nada foi criado. o que você escreveu continua aqui.';

test('a 502 with no issue keeps every field, says nothing was created, and tentar de novo posts the same body again (#772)', async () => {
  const user = await refused({ error: 'Bad credentials' }, 502);
  expect(screen.getByRole('alert')).toHaveTextContent(FAILED);
  expect(screen.queryByText(/Bad credentials/)).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('descrição')).toHaveValue('steps');
  await user.click(screen.getByRole('button', { name: 'tentar de novo' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]).toEqual(posts()[0]);
});

test('a 502 that carries the issue links it and offers fechar, which posts nothing; an edit does not take it back (#772)', async () => {
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
  const user = await refused({ error: 'not on the Project', ref: REF }, 502);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('a issue #912 foi criada em acme/app, mas não entrou no project.');
  await user.click(within(alert).getByRole('button', { name: 'ver no GitHub' }));
  expect(opened).toHaveBeenCalledWith(REF.url, '_blank', 'noreferrer');
  await user.type(screen.getByLabelText('título'), '!');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(1);
});

test('a 400 shows its own inline error, not the 502\'s, and keeps criar issue; an edit clears it (#772)', async () => {
  const user = await refused({ error: 'unknown label: bug' }, 400);
  expect(screen.getByRole('alert')).toHaveTextContent('o GitHub recusou a issue em acme/app: uma label ou o status não existe mais. nada foi criado.');
  expect(screen.getByRole('alert')).not.toHaveTextContent(FAILED);
  expect(screen.queryByText(/unknown label/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'criar issue' })).toBeEnabled();
  await user.type(screen.getByLabelText('título'), '!');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('opened from a source table the header line ends with · da tabela de <source>; opened without one it is create.context alone (#774)', () => {
  const { unmount } = open({ source: 'work', targets: TARGETS });
  expect(screen.getByText('só cria a tarefa, sem iniciar atividade · da tabela de work')).toBeInTheDocument();
  unmount();
  const again = open({ title: 'Fix login', workspace: 'site' });
  expect(screen.getByText('só cria a tarefa, sem iniciar atividade')).toBeInTheDocument();
  expect(screen.queryByText(/da tabela de/)).not.toBeInTheDocument();
  again.unmount();
  setLanguage('en');
  open({ source: 'hive' });
  expect(screen.getByText('only creates the task, starts no activity · from the hive table')).toBeInTheDocument();
});
