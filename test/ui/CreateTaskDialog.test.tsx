import { render, screen, waitFor } from '@testing-library/react';
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
