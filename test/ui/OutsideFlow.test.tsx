import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OutsideFlow } from '@/components/tasks/OutsideFlow';
import type { DisplayControls } from '@/hooks/use-flow-view';
import { setLanguage } from '@/i18n';
import { DISPLAY_DEFAULTS, type DisplayOptions } from '@/lib/flow-view';
import type { BaseOptions, Item, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

// The outside-the-flow grid (#578). Radix's ContextMenu opens once per file under jsdom: one test here right-clicks, no other may
const STAGES: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
// #566: no stage is outside the flow; a branch gives the task an activity, so it is started (#568)
const task = (id: string, extra: Partial<WithWork> = {}, item: Partial<Item> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, boardColumn: 'Ready', auto: false, ...extra,
});
const started = (id: string, extra: Partial<WithWork> = {}, item: Partial<Item> = {}): WithWork => task(id, { branch: `hive/${id}-task-${id}`, ...extra }, item);
const state = (tasks: WithWork[], workspaces = ['hive']): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(STAGES, []), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces, sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const display = (options: Partial<DisplayOptions> = {}): DisplayControls => ({ options: { ...DISPLAY_DEFAULTS, ...options }, set: vi.fn() });
const show = (s: State, { options = {}, onOpen = vi.fn(), selectedId }: { options?: Partial<DisplayOptions>; onOpen?: (id: string) => void; selectedId?: string } = {}) =>
  render(<OutsideFlow state={s} display={display(options)} onOpen={onOpen} selectedId={selectedId} />);
const group = (name: string) => within(screen.getByRole('region', { name }));
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-task-id="I${id}"]`)!;
const ids = (name: string): string[] => [...screen.getByRole('region', { name }).querySelectorAll('[data-task-id]')].map((li) => li.getAttribute('data-task-id') ?? '');
const BASES: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }; // what the Start dialog reads
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => reply(String(input).endsWith('/bases') ? BASES : { ok: true }))); });
afterEach(() => vi.unstubAllGlobals());

test('the grid holds the stageless tasks alone: the started under com atividade first, the others under novas, each head with its name, count and hint (#578)', () => {
  show(state([task('1', { stage: 'dev' }), started('2'), task('3'), started('4')]));
  expect(document.querySelector('[data-task-id="I1"]')).toBeNull();
  expect(ids('com atividade')).toEqual(['I2', 'I4']);
  expect(ids('novas')).toEqual(['I3']);
  const head = group('com atividade').getByRole('heading', { name: 'com atividade' });
  expect(head).toHaveClass('font-medium');
  expect(head.nextElementSibling).toHaveTextContent('2');
  expect(group('com atividade').getByText('iniciadas · ficam até você remover ou levar ao fluxo')).toHaveClass('ml-auto');
  expect(group('novas').getByText('sem atividade · somem se saírem da listagem')).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['com atividade', 'novas']);
});

test('a task of an unchecked source and an epic esconder epics hides are left out; the search narrows the cards, by branch too (#578)', async () => {
  const user = userEvent.setup();
  show(state([task('1', {}, { source: 'roadmap' }), task('2', {}, { children: ['I3'] }), task('3', {}, { parent: 'I2' }), started('4')]), { options: { sourcesOff: ['roadmap'], epics: 'all' } });
  expect(ids('novas')).toEqual(['I3']);
  expect(ids('com atividade')).toEqual(['I4']);
  await user.type(screen.getByRole('textbox', { name: 'buscar tarefas' }), 'hive/4');
  expect(screen.queryByRole('region', { name: 'novas' })).not.toBeInTheDocument();
  expect(ids('com atividade')).toEqual(['I4']);
});

test('a group with no card is not drawn; with no stageless task the center says so in one muted line (#578)', () => {
  const { unmount } = show(state([task('1')]));
  expect(screen.queryByRole('region', { name: 'com atividade' })).not.toBeInTheDocument();
  expect(ids('novas')).toEqual(['I1']);
  unmount();
  show(state([task('1', { stage: 'dev' })]));
  expect(screen.getByText('nenhuma tarefa fora do fluxo')).toHaveClass('text-muted-foreground');
  expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
});

test('a card: out of the listing, its ◌ line and a dashed border; its second line workspace · branch when started, workspace · nova when new, no separator with no workspace; the legend names the shown cards\' workspaces (#578)', () => {
  show(state([started('1', { workspace: 'hive', outOfListing: 'filter' }), task('2', { workspace: 'site' }), task('3')], ['hive', 'site']), { selectedId: 'I1' });
  expect(within(card('1')).getByText('◌ fora do filtro')).toBeInTheDocument();
  expect(card('1')).toHaveClass('border-dashed', 'bg-card', 'rounded-lg');
  expect(card('1')).toHaveAttribute('aria-current', 'true');
  expect(card('2')).not.toHaveClass('border-dashed');
  expect(within(card('1')).getByText('hive · hive/1-task-1')).toHaveClass('text-muted-foreground', 'text-xs');
  expect(within(card('2')).getByText('site · nova')).toBeInTheDocument();
  expect(within(card('3')).getByText('nova')).toBeInTheDocument();
  expect([...screen.getByRole('group', { name: 'workspaces' }).children].map((row) => row.textContent)).toEqual(['hive', 'site']);
});
