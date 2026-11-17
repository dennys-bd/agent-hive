import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { type CreateDraft, withOptions } from '@/hooks/use-create-draft';
import { setLanguage } from '@/i18n';
import { type CreateTargets, CreateTargetsContext } from '@/lib/create-targets';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }));

// #831: a GitHub source and a Jira one, whose new issues default to Story
const TARGETS: CreateTargets = { hiveSource: true, createIn: 'hive', sources: [{ name: 'work', type: 'github', repository: 'acme/app' }, { name: 'tickets', type: 'jira', project: 'ABC', issueType: 'Story' }] };

// the issue types of a Jira project, by Jira's hierarchy level
const TYPES = [{ name: 'Epic', level: 1 }, { name: 'Bug', level: 0 }, { name: 'Story', level: 0 }, { name: 'Sub-task', level: -1 }];
const DRAFT: CreateDraft = { title: 'Fix', body: '', destination: 'github', workspace: undefined, stage: undefined, source: 'tickets', status: undefined, labels: [], issueType: undefined };

test('withOptions defaults the type to the source\'s, else to the first type that is no subtask, and never leaves a Jira status off the Project (#831)', () => {
  const jira = { statuses: ['To Do'], labels: [], issueTypes: TYPES };
  expect(withOptions(DRAFT, 'tickets', jira, 'Story')).toMatchObject({ status: 'To Do', issueType: 'Story' });
  expect(withOptions(DRAFT, 'tickets', jira, 'Task').issueType).toBe('Epic');
  expect(withOptions(DRAFT, 'tickets', { ...jira, issueTypes: [TYPES[3], TYPES[1]] }, 'Sub-task').issueType).toBe('Bug');
  expect(withOptions(DRAFT, 'tickets', { ...jira, statuses: [] }, 'Story').status).toBeUndefined();
  expect(withOptions({ ...DRAFT, source: 'work' }, 'work', { statuses: [], labels: [] })).toMatchObject({ status: null, issueType: undefined });
});

const OPTIONS: Readonly<Record<string, unknown>> = { work: { statuses: ['Backlog'], labels: ['bug'] }, tickets: { statuses: ['To Do', 'In Progress'], labels: ['api'], issueTypes: TYPES } };
const REF = { id: 'ABC-7', url: 'https://acme.example/browse/ABC-7' };
let settle: (res: Response) => void = () => undefined;
const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// create-options answer at once (getJson passes no init); every POST waits for settle
const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const name = /^\/sources\/(\w+)\/create-options$/.exec(String(input))?.[1];
  return name === undefined || init !== undefined ? new Promise<Response>((resolve) => { settle = resolve; }) : Promise.resolve(json(OPTIONS[name], 200));
});
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)) as unknown);
const open = (source: string) => render(
  <CreateTargetsContext.Provider value={TARGETS}>
    <CreateTaskDialog state={{ workspaces: ['hive'], flows: [], sourceWorkspaces: {} }} source={source} title="Fix" onClose={vi.fn()} onOpenTask={vi.fn()} />
  </CreateTargetsContext.Provider>,
);
const box = (name: string | RegExp) => screen.getByRole('combobox', { name });

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('a jira source shows the type menu on its default, without subtask types, and no fora do project; criar issue posts the type picked (#831)', async () => {
  const user = userEvent.setup();
  open('tickets');
  await waitFor(() => expect(box(/status/)).toHaveTextContent('To Do'));
  expect(box('tipo de issue')).toHaveTextContent('Story');
  await user.click(box(/status/));
  expect(screen.queryByRole('option', { name: 'fora do project' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await user.click(box('tipo de issue'));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Epic', 'Bug', 'Story']);
  await user.click(screen.getByRole('option', { name: 'Bug' }));
  await user.click(screen.getByRole('button', { name: 'criar issue' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toEqual({ title: 'Fix', body: '', source: 'tickets', labels: [], status: 'To Do', issueType: 'Bug' });
});

test('a github source shows no type menu and keeps fora do project (#831)', async () => {
  const user = userEvent.setup();
  open('work');
  await waitFor(() => expect(box(/status/)).toHaveTextContent('Backlog'));
  expect(screen.queryByRole('combobox', { name: 'tipo de issue' })).not.toBeInTheDocument();
  await user.click(box(/status/));
  expect(await screen.findByRole('option', { name: 'fora do project' })).toBeInTheDocument();
});

test('the Jira failure lines name the project, a refusal gives Jira\'s reason, and a placed issue names its key with ver no Jira (#831)', async () => {
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
  const cases: [unknown, number, string][] = [
    [{ error: 'jira api: HTTP 500' }, 502, 'não deu para criar a issue em ABC: o Jira falhou. nada foi criado. o que você escreveu continua aqui.'],
    [{ error: 'issue type "Bug" is not one of ABC\'s: Story' }, 400, 'o Jira recusou a issue em ABC: issue type "Bug" is not one of ABC\'s: Story. nada foi criado.'],
    [{ error: 'issue ABC-7 was created but did not reach "In Progress": x', ref: REF }, 502, 'a issue ABC-7 foi criada em ABC, mas não chegou ao status.'],
  ];
  for (const [answer, status, line] of cases) {
    fetchMock.mockClear();
    const user = userEvent.setup();
    const { unmount } = open('tickets');
    await waitFor(() => expect(box(/status/)).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'criar issue' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    settle(json(answer, status));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(line);
    expect(alert).not.toHaveTextContent(/GitHub/);
    if (status === 502 && (answer as { ref?: unknown }).ref !== undefined) {
      await user.click(within(alert).getByRole('button', { name: 'ver no Jira' }));
      expect(opened).toHaveBeenCalledWith(REF.url, '_blank', 'noreferrer');
    }
    unmount();
  }
});
