import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { setLanguage } from '@/i18n';
import { type CreateTargets, CreateTargetsContext, createTargetsOf } from '@/lib/create-targets';
import type { Flow, SourceConfig } from '../../src/types';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }));

const base = { qualifyId: false, type: 'github' as const, owner: 'me', number: 1, epics: 'show' as const, epicFollows: 'aheadThenBehind' as const, switchAt: 'Spec' };
const hiveSource: SourceConfig = {
  ...base, name: 'agent-hive', repository: 'me/agent-hive', filter: [],
  taskProps: {
    defaults: { workspace: 'agent-hive', auto: true, entry: { flow: 'entrega com checks' } },
    rules: [{ field: 'labels', op: 'contains', value: 'other', set: { workspace: 'x' } }, { field: 'labels', op: 'contains', value: 'discovery', set: { entry: { flow: 'discovery' } } }],
  },
};
const siteSource: SourceConfig = {
  ...base, name: 'hive-site', repository: 'me/site', filter: [{ field: 'label', op: 'any', values: ['site'] }],
  taskProps: { defaults: { workspace: 'site', auto: true, entry: null }, rules: [] },
};
const flows: Flow[] = [
  { name: 'entrega com checks', stages: [{ name: 'Spec', from: { 'agent-hive': ['Backlog'], 'hive-site': ['Backlog'] }, prompt: 'x' }, { name: 'Build', from: { 'agent-hive': ['Ready'] }, prompt: 'x' }], transitions: [] },
  { name: 'discovery', stages: [{ name: 'Brainstorm', from: { 'agent-hive': ['Backlog'] }, prompt: 'x' }], transitions: [] },
];
const targets: CreateTargets = createTargetsOf({ sources: [hiveSource, siteSource], createIn: 'agent-hive' });
const OPTIONS: Record<string, unknown> = {
  'agent-hive': { statuses: ['Backlog', 'Ready', 'Done'], labels: ['discovery', 'bug'] },
  'hive-site': { statuses: ['Backlog'], labels: ['site', 'bug'] },
};
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const open = (t: CreateTargets = targets, source: string = 'agent-hive') => render(
  <CreateTargetsContext.Provider value={t}>
    <CreateTaskDialog state={{ workspaces: ['hive'], flows, sourceWorkspaces: {} }} source={source} title="Fix" onClose={vi.fn()} onOpenTask={vi.fn()} />
  </CreateTargetsContext.Provider>,
);
const pick = async (user: ReturnType<typeof userEvent.setup>, box: string | RegExp, option: string) => {
  await user.click(screen.getByRole('combobox', { name: box }));
  await user.click(await screen.findByRole('option', { name: option }));
};
const box = () => screen.getByRole('status');

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(json(OPTIONS[/^\/sources\/([\w-]+)\//.exec(String(input))?.[1] ?? ''] ))));
});
afterEach(() => vi.unstubAllGlobals());

test('a Backlog draft shows the source, the workspace and the entry with the status reason', async () => {
  open();
  const el = await screen.findByRole('status');
  expect(el).toHaveTextContent('pela source agent-hive: workspace agent-hive · entra em entrega com checks · Spec');
  expect(el).toHaveTextContent('status Backlog leva a Spec');
  expect(within(el).getByText('entrega com checks · Spec').tagName).toBe('B');
  expect(el).toHaveAttribute('aria-live', 'polite');
});

test('a label a rule reads switches the entry at once, with the rule number', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('status');
  await user.click(screen.getByRole('button', { name: /label/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'discovery' }));
  expect(box()).toHaveTextContent('entra em discovery · Brainstorm');
  expect(box()).toHaveTextContent('regra 2: labels contém discovery');
});

test('another status changes the stage', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('status');
  await pick(user, /status/, 'Ready');
  expect(box()).toHaveTextContent('entra em entrega com checks · Build');
  expect(box()).toHaveTextContent('status Ready leva a Build');
  await pick(user, /status/, 'Done');
  expect(box()).toHaveTextContent('nenhuma source pega esta issue: ela é criada no GitHub e fica fora do hive.');
  expect(box()).toHaveTextContent('nenhum fluxo cita o status Done');
});

test('fora do project and a filter miss say why no source takes the issue', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByRole('status');
  await pick(user, /status/, 'fora do project');
  expect(box()).toHaveTextContent('a issue fica fora do project, e a source agent-hive só lê o project');
  await pick(user, /repositório|repository/, 'me/site');
  expect(box()).toHaveTextContent('nenhuma source pega esta issue');
  expect(box()).toHaveTextContent('a source hive-site só pega issues com a label site');
});

test('a source with no entry reads sem fluxo and the defaults reason; English too', async () => {
  const user = userEvent.setup();
  open(targets, 'hive-site');
  await screen.findByRole('status');
  await user.click(screen.getByRole('button', { name: /label/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'site' }));
  expect(box()).toHaveTextContent('pela source hive-site: workspace site · sem fluxo');
  expect(box()).toHaveTextContent('a source não põe a tarefa num fluxo');
});

test('English copy', async () => {
  setLanguage('en');
  open();
  expect(await screen.findByRole('status')).toHaveTextContent('via source agent-hive: workspace agent-hive · enters entrega com checks · Spec');
});

test('absent while the options load, and under the hive destination', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  const { unmount } = open();
  expect(screen.queryByRole('status')).toBeNull();
  unmount();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(OPTIONS['agent-hive']))));
  open(targets, 'hive');
  expect(screen.queryByRole('status')).toBeNull();
});
