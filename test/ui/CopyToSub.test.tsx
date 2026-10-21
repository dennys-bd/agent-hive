import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CopySessionHost, CopyToSub } from '@/components/CopySession';
import { DROPDOWN_KIT } from '@/components/menu-kit';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { setLanguage } from '@/i18n';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const task = (itemId: string, id: string, title: string, project: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId, id, title, body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, workspace: project, worktree: `/w/${id}`, branch: `hive/${id}`, ...extra,
});
const state: State = movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [], localCount: 0, benchmark: { experiments: [] }, activities: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], sourceOrder: [],
  activityRecords: [{ id: 'a-I11', taskIds: ['I11'], sessions: [{ id: S, startedAt: '', stages: ['dev'], agent: 'claude', lastUsedAt: '' }] }], // #629: the source's session is its record's
  tasks: [task('I11', '11', 'source', 'hive'), task('I542', '542', 'Redesign 10 · Board', 'hive'), task('I7', '7', 'elsewhere', 'site')],
  workspaces: ['hive', 'site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/workspaces/branches'
    ? reply([{ name: 'hive', branch: 'main' }, { name: 'site', branch: 'dev' }])
    : reply({ from: { path: '/w/11', branch: 'hive/11' }, to: { path: '/repo', branch: 'main' }, messages: 1, tokens: 0, uncommitted: 0 }))));
});
afterEach(() => vi.unstubAllGlobals());

function Harness() {
  return (
    <CopySessionHost state={state}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button">menu</button></DropdownMenuTrigger>
        <DropdownMenuContent><CopyToSub source={{ activityId: 'a-I11', sessionId: S }} kit={DROPDOWN_KIT} /></DropdownMenuContent>
      </DropdownMenu>
    </CopySessionHost>
  );
}

test('copiar para… lists the workspace, local with its branch, its other activities with their branch, then nova atividade…; the source and other workspaces stay out; a pick opens the dialog (#587, 6a)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  screen.getByRole('button', { name: 'menu' }).focus();
  await user.keyboard('{Enter}');
  screen.getByRole('menuitem', { name: 'copiar para…' }).focus();
  await user.keyboard('{ArrowRight}');
  const sub = await screen.findByRole('menu', { name: 'copiar para…' });
  expect(within(sub).getByText('hive')).toBeInTheDocument();
  expect(await within(sub).findByText('main')).toHaveClass('font-mono');
  expect(within(sub).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['localmain', '#542 Redesign 10 · Boardhive/542', 'nova atividade…']);
  await user.click(within(sub).getByRole('menuitem', { name: /^local/ }));
  expect(await screen.findByRole('dialog', { name: 'Copiar sessão para local' })).toBeInTheDocument();
});

test('outside a host, copiar para… is not there at all (#587)', async () => {
  const user = userEvent.setup();
  render(<DropdownMenu><DropdownMenuTrigger asChild><button type="button">menu</button></DropdownMenuTrigger><DropdownMenuContent><CopyToSub source={{ activityId: 'a-I11', sessionId: S }} kit={DROPDOWN_KIT} /><span>x</span></DropdownMenuContent></DropdownMenu>);
  screen.getByRole('button', { name: 'menu' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('menuitem', { name: 'copiar para…' })).not.toBeInTheDocument();
});

test('nova atividade… opens the Start dialog in the source\'s workspace, not the copy dialog (#587, 6a)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  screen.getByRole('button', { name: 'menu' }).focus();
  await user.keyboard('{Enter}');
  screen.getByRole('menuitem', { name: 'copiar para…' }).focus();
  await user.keyboard('{ArrowRight}');
  await user.click(await screen.findByRole('menuitem', { name: 'nova atividade…' }));
  expect(await screen.findByRole('dialog', { name: 'Nova atividade' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: /Copiar sessão/ })).not.toBeInTheDocument();
});
