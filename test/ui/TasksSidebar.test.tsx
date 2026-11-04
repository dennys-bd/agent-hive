import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TasksEntries } from '@/components/tasks/TasksEntries';
import { TasksSidebar, type TasksSidebarProps } from '@/components/tasks/TasksSidebar';
import { FIRST_CENTER } from '@/hooks/use-tasks-center';
import { resetRepositories } from '@/hooks/use-repositories';
import { setLanguage } from '@/i18n';
import { DISPLAY_DEFAULTS } from '@/lib/flow-view';
import { readView, resetViewState } from '@/lib/view-state';
import type { RepoSummary } from '../../src/types';
import { NOTES, ROADMAP, SIDEBAR_STATE } from './sidebar-fixtures.js';


const row = (name: RegExp): HTMLElement => screen.getByRole('button', { name });
const pressed = (): string[] => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent ?? '');

test('the tasks rows: todas em lista, one per flow in the state\'s order, sem fluxo, each with ● N in yellow when some wait for you, then its total (#572)', () => {
  render(<TasksEntries state={SIDEBAR_STATE} center={FIRST_CENTER} show={vi.fn()} />);
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['todas em lista● 35', 'build● 11', 'ship● 12', 'sem fluxo● 12']);
  expect(within(row(/^build/)).getByText('● 1')).toHaveClass('text-signal-yellow');
});

test('● N is hidden when none of the row\'s tasks waits for you (#572)', () => {
  render(<TasksEntries state={{ ...SIDEBAR_STATE, workers: [], activities: [] }} center={FIRST_CENTER} show={vi.fn()} />);
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['todas em lista5', 'build1', 'ship2', 'sem fluxo2']);
});

test('the row of the shown center is selected (the first flow\'s for a flow center with no flow), none under a source; a click shows its center (#572)', async () => {
  const user = userEvent.setup();
  const show = vi.fn();
  const { rerender } = render(<TasksEntries state={SIDEBAR_STATE} center={FIRST_CENTER} show={show} />);
  expect(pressed()).toEqual(['build● 11']);
  rerender(<TasksEntries state={SIDEBAR_STATE} center={{ kind: 'tasks', view: 'flow', flow: 'ship' }} show={show} />);
  expect(pressed()).toEqual(['ship● 12']);
  rerender(<TasksEntries state={SIDEBAR_STATE} center={{ kind: 'tasks', view: 'outside' }} show={show} />);
  expect(pressed()).toEqual(['sem fluxo● 12']);
  rerender(<TasksEntries state={SIDEBAR_STATE} center={{ kind: 'source', source: 'roadmap' }} show={show} />);
  expect(pressed()).toEqual([]);
  await user.click(row(/^todas em lista/));
  await user.click(row(/^ship/));
  await user.click(row(/^sem fluxo/));
  expect(show.mock.calls).toEqual([[{ kind: 'tasks', view: 'list' }], [{ kind: 'tasks', view: 'flow', flow: 'ship' }], [{ kind: 'tasks', view: 'outside' }]]);
});

const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 2, openIssues: 3, closedIssues: 1, canPush: true, issuesEnabled: true, lastActivity: '2026-10-05T09:00:00Z', syncedAt: '2026-10-05T09:00:00Z' };
let listed: RepoSummary[] = [];
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  setLanguage('pt');
  listed = [];
  resetRepositories();
  resetViewState();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json(String(input) === '/repositories' ? listed : { ok: true })));
});
afterEach(() => vi.unstubAllGlobals());

function renderSidebar(over: Partial<TasksSidebarProps> = {}) {
  const props: TasksSidebarProps = {
    state: SIDEBAR_STATE, sources: { sources: [ROADMAP, NOTES], auth: 'cli', onAdd: vi.fn() }, nav: { center: FIRST_CENTER, show: vi.fn() },
    display: { options: DISPLAY_DEFAULTS, set: vi.fn() }, onNewFlow: vi.fn(), ...over,
  };
  return { ...render(<TasksSidebar {...props} />), props };
}
const toggle = (title: string): HTMLElement => screen.getByRole('button', { name: `seção ${title}` });
const section = (title: string): HTMLElement => toggle(title).closest<HTMLElement>('[data-section]')!;
const titles = (): string[] => screen.getAllByRole('button', { name: /^seção / }).map((b) => b.textContent ?? '');
// Alt types a symbol on macOS, so the digit is read from code (#585)
const alt = (digit: number): boolean => fireEvent.keyDown(window, { key: '™', code: `Digit${digit}`, altKey: true });

test('the four sections in a fixed order; a title click collapses one and keeps the order; the last open one is the flexible one (#572)', async () => {
  const user = userEvent.setup();
  renderSidebar();
  expect(titles()).toEqual(['automação', 'tarefas', 'sources', 'repositórios']);
  expect(section('automação')).toHaveStyle({ height: '200px' });
  expect(section('tarefas')).toHaveStyle({ height: '150px' });
  expect(section('sources')).toHaveStyle({ height: '200px' });
  expect(section('repositórios')).toHaveClass('flex-[1_1_0]');
  expect(screen.getAllByRole('separator').map((s) => s.getAttribute('aria-label'))).toEqual(['redimensionar automação', 'redimensionar tarefas', 'redimensionar sources']);
  await user.click(toggle('repositórios'));
  expect(toggle('repositórios')).toHaveAttribute('aria-expanded', 'false');
  expect(titles()).toEqual(['automação', 'tarefas', 'sources', 'repositórios']);
  expect(section('sources')).toHaveClass('flex-[1_1_0]');
  expect(screen.getAllByRole('separator')).toHaveLength(2);
  expect(readView('tasksSidebar')).toMatchObject({ closed: { repos: true } });
});

test('a drag on a handle changes the upper section within 60–560 and writes tasksSidebar once, on mouseup (#572)', () => {
  renderSidebar();
  fireEvent.mouseDown(screen.getByRole('separator', { name: 'redimensionar automação' }), { clientY: 300 });
  fireEvent.mouseMove(window, { clientY: 350 });
  expect(section('automação')).toHaveStyle({ height: '250px' });
  expect(readView('tasksSidebar')).toBeUndefined();
  fireEvent.mouseMove(window, { clientY: 2000 });
  expect(section('automação')).toHaveStyle({ height: '560px' });
  fireEvent.mouseUp(window);
  expect(readView('tasksSidebar')).toMatchObject({ heights: { automation: 560, tasks: 150 } });
  fireEvent.mouseMove(window, { clientY: 0 });
  expect(section('automação')).toHaveStyle({ height: '560px' }); // the listeners went with the mouseup
});

test('an unmount mid-drag drops the listeners and writes nothing; a handle click with no move writes nothing (#572)', () => {
  const { unmount } = renderSidebar();
  const handle = screen.getByRole('separator', { name: 'redimensionar automação' });
  fireEvent.mouseDown(handle, { clientY: 300 });
  fireEvent.mouseUp(window);
  expect(readView('tasksSidebar')).toBeUndefined();
  fireEvent.mouseDown(handle, { clientY: 300 });
  fireEvent.mouseMove(window, { clientY: 350 });
  unmount();
  fireEvent.mouseUp(window);
  expect(readView('tasksSidebar')).toBeUndefined();
});

test('a reload restores the closed flags and the heights (#572)', () => {
  resetViewState({ tasksSidebar: { closed: { automation: false, tasks: true, sources: false, repos: false }, heights: { automation: 120, tasks: 150, sources: 300, repos: 240 } } });
  renderSidebar();
  expect(toggle('tarefas')).toHaveAttribute('aria-expanded', 'false');
  expect(section('automação')).toHaveStyle({ height: '120px' });
  expect(section('sources')).toHaveStyle({ height: '300px' });
});

test('a source row: icon, name and count over owner · type; the hive row first on one line; the tooltip names the key; no key caps (#572)', () => {
  renderSidebar();
  const rows = within(section('sources')).getAllByRole('button', { name: /^(hive|roadmap|notes)/ });
  expect(rows.map((r) => r.textContent)).toEqual(['hive1', 'roadmap3acme · github project', 'notes1acme · github project']);
  expect(rows.map((r) => r.title)).toEqual(['hive · Alt+1', 'roadmap · acme · Alt+2', 'notes · acme · Alt+3']);
  expect(within(rows[1]).getByText('acme · github project')).toHaveClass('pl-6');
  expect(document.querySelector('[data-key-hint]')).toBeNull();
  expect(within(section('sources')).queryByRole('button', { name: /^todas/ })).not.toBeInTheDocument();
});

test('a source row\'s click and ⌥n open its table, hive on ⌥1; ⌥0 opens todas em lista; a closed sources section still answers (#572)', async () => {
  const user = userEvent.setup();
  const { props } = renderSidebar();
  await user.click(screen.getByText('roadmap'));
  alt(1);
  await user.click(toggle('sources'));
  alt(3);
  alt(0);
  expect(alt(4)).toBe(true); // no row: the key goes on
  expect(vi.mocked(props.nav.show).mock.calls).toEqual([
    [{ kind: 'source', source: 'roadmap' }], [{ kind: 'source', source: 'hive' }], [{ kind: 'source', source: 'notes' }], [{ kind: 'tasks', view: 'list' }],
  ]);
});

test('the source ⋯ menu renders outside the sidebar; mostrar só esta turns every other source off, hive included, and leaves the center (#572)', async () => {
  const user = userEvent.setup();
  const { container, props } = renderSidebar();
  screen.getByRole('button', { name: 'ações de roadmap' }).focus(); // Radix's menu opens on a key under jsdom, not on a click
  await user.keyboard('{Enter}');
  const only = screen.getByRole('menuitem', { name: 'mostrar só esta' });
  expect(container.contains(only)).toBe(false);
  await user.click(only);
  expect(props.display.set).toHaveBeenCalledWith({ sourcesOff: ['hive', 'notes'] });
  expect(props.nav.show).not.toHaveBeenCalled();
});

test('the shown center selects one row across the sections: a source, a repository (#572)', async () => {
  listed = [SITE];
  renderSidebar({ nav: { center: { kind: 'source', source: 'notes' }, show: vi.fn() } });
  expect(screen.getByRole('button', { name: /^notes/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /^build/ })).toHaveAttribute('aria-pressed', 'false');
  expect(await screen.findByTitle('acme/site')).toHaveAttribute('aria-pressed', 'false');
});

test('a repository row shows its square, its name and PR count over its context; the section reads PRs and shows even when empty (#572)', async () => {
  listed = [SITE];
  const { props } = renderSidebar();
  const site = await screen.findByTitle('acme/site');
  expect(within(site).getByText('site')).toBeInTheDocument();
  expect(within(site).getByText('2')).toHaveClass('tabular-nums');
  expect(within(section('repositórios')).getByText('PRs')).not.toHaveAttribute('role', 'button');
  await userEvent.setup().click(within(site).getByText('site'));
  expect(props.nav.show).toHaveBeenCalledWith({ kind: 'repo', repository: 'acme/site', tab: 'prs' });
});

test('with no repository listed the repositories section still shows, empty (#572)', async () => {
  renderSidebar();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/repositories'));
  expect(toggle('repositórios')).toHaveAttribute('aria-expanded', 'true');
  expect(within(section('repositórios')).queryAllByRole('button', { pressed: false })).toEqual([]);
});

test('the tasks + calls onNewFlow and the sources + calls onAdd; neither toggles its section; with no handler there is no + (#572)', async () => {
  const user = userEvent.setup();
  const { props, unmount } = renderSidebar();
  await user.click(screen.getByRole('button', { name: 'novo fluxo' }));
  await user.click(screen.getByRole('button', { name: 'adicionar source' }));
  expect(props.onNewFlow).toHaveBeenCalledOnce();
  expect(props.sources.onAdd).toHaveBeenCalledOnce();
  expect([toggle('tarefas'), toggle('sources')].map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
  unmount();
  renderSidebar({ onNewFlow: undefined, sources: { sources: [ROADMAP], auth: 'cli' } });
  expect(screen.queryByRole('button', { name: 'novo fluxo' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'adicionar source' })).not.toBeInTheDocument();
});
