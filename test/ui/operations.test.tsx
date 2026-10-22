import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ruleLabel } from '@/lib/rule-effects';
import { setLanguage } from '@/i18n';
import { activitiesOf, isTask, type TaskActivity } from '@/lib/activities';
import type { Terminal } from '@xterm/xterm';
import { onPanelKey, onShortcutKey } from '@/lib/dock-layout';
import { trackTerminal } from '@/lib/xterm-setup';
import { isListed, itemPage, type Operation, type OperationContext, operationsFor, viewOf } from '@/lib/operations';
import type { EffectiveLimits, State, UsageRule } from '../../src/types';
import { ctxOf, navOf, recordFor, stateOf, task } from './search-fixtures';
import { activityIdOf, bareTask } from '../fixtures/work';

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

// Since #590 activitiesOf starts with every workspace's local activity: the task's is the one after it
const taskActivity = (state: State): TaskActivity => {
  const found = activitiesOf(state).find(isTask);
  if (found === undefined) throw new Error('no task activity');
  return found;
};

// label · target, as the row reads it
const text = (op: Operation, ctx: OperationContext): string => {
  const view = viewOf(op, ctx);
  return view.target === undefined ? view.label : `${view.label} · ${view.target}`;
};

test('with nothing open and nothing focused only the global group lists, in the registry order, each with its shortcut (#584, #639)', () => {
  const ctx = ctxOf(stateOf([]));
  const ops = operationsFor(ctx);
  expect(ops.map((op) => text(op, ctx))).toEqual([
    'ir para atividades', 'ir para fluxo', 'ir para plugins', 'ir para benchmark', 'abrir ou fechar o painel da esquerda', 'abrir ou fechar o painel da direita', 'abrir ou fechar o console',
    'nova atividade', 'novo terminal', 'o mapa de atalhos', 'sinal',
  ]);
  expect(new Set(ops.map((op) => op.group))).toEqual(new Set(['global']));
  expect(ops.map((op) => op.shortcut)).toEqual(['viewActivities', 'viewFlow', 'viewPlugins', 'viewBenchmark', 'toggleLeft', 'toggleRight', 'toggleConsole', 'newActivity', 'newTerminal', 'shortcutMap', undefined]);
});

test('a global operation does what its key does: its run reaches the key\'s own listener (#584)', () => {
  const toggle = vi.fn();
  const stop = onPanelKey(toggle);
  const ctx = ctxOf(stateOf([]));
  operationsFor(ctx).find((op) => op.id === 'toggleRight')?.run?.(ctx);
  stop();
  expect(toggle).toHaveBeenCalledWith('right');
});

test('sinal › lists the signals the floor allows, the stored one checked, and posts the pick; pausar regra › lists each fired and paused rule with the footer\'s horizons (#584)', async () => {
  const fired: UsageRule = { source: 'week', percent: 90, maxWorkers: 2 };
  const paused: UsageRule = { source: 'session', percent: 80, signal: 'red' };
  const effective: EffectiveLimits = {
    signal: 'yellow', floor: { signal: 'yellow' }, signalRules: [], capRules: [fired], disabledRules: [{ rule: paused, until: 'manual', estimate: false }], stageCaps: {}, stageCapRules: {},
  };
  const ctx = ctxOf(stateOf([], { signal: 'red' }), { effective });
  const signals = operationsFor(ctx).find((op) => op.id === 'signal')?.children?.(ctx) ?? [];
  expect(signals.map((op) => [op.label(ctx), op.checked?.(ctx)])).toEqual([['yellow', false], ['red', true]]);
  signals[0].run?.(ctx);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/signal', expect.objectContaining({ body: JSON.stringify({ signal: 'yellow' }) })));
  const rules = operationsFor(ctx).find((op) => op.id === 'pauseRule')?.children?.(ctx) ?? [];
  expect(rules.map((op) => op.label(ctx))).toEqual([ruleLabel(fired), ruleLabel(paused)]);
  expect(rules[0].children?.(ctx).map((op) => op.label(ctx))).toEqual(['até resetar', '15 min', '1 h', '4 h', 'até amanhã']);
  expect(rules[1].children?.(ctx).map((op) => op.label(ctx))[0]).toBe('retomar agora');
});

test('configurações lists only where the page can open the settings, and opens them (#584)', () => {
  expect(operationsFor(ctxOf(stateOf([]))).some((op) => op.id === 'settings')).toBe(false);
  const openSettings = vi.fn();
  const ctx = ctxOf(stateOf([]), { nav: { ...navOf(), openSettings } });
  operationsFor(ctx).find((op) => op.id === 'settings')?.run?.(ctx);
  expect(openSettings).toHaveBeenCalled();
});

test('with an activity open its group comes before the global one, each labelled with the activity; with none it lists nowhere (#584)', () => {
  const build = task('11', 'Build', { worktree: '/w/11' });
  const state = stateOf([build], { workers: [{ id: 's1', activityId: activityIdOf('I11'), status: 'working', runId: 'W1' }] });
  const activity = taskActivity(state);
  const ctx = ctxOf(state, { activity, isShown: true });
  const ops = operationsFor(ctx);
  expect(ops.map((op) => op.group).indexOf('global')).toBeGreaterThan(ops.map((op) => op.group).lastIndexOf('activity'));
  expect(ops.filter((op) => op.group === 'activity').map((op) => text(op, ctx))).toEqual(['nova sessão · #11', 'diff · #11', 'mostrar PR · #11', 'dividir com o mesmo tipo · #11']);
  expect(ops.find((op) => op.id === 'activity.diff')?.children?.(ctx).map((op) => op.label(ctx))).toEqual(['diff da worktree']);
  expect(ops.find((op) => op.id === 'activity.newSession')?.children?.(ctx).map((op) => op.label(ctx))).toEqual(['claude', 'codex']);
  expect(operationsFor(ctxOf(state)).some((op) => op.group === 'activity')).toBe(false);
});

test('executar lists the workspace commands from commandsOf, disabled while canRunCommand refuses, and runs through runCommand (#584)', async () => {
  const build = task('11', 'Build', { worktree: '/w/11', workspace: 'hive' });
  const state = stateOf([build], { commands: { hive: ['dev', 'test'] } });
  const activity = taskActivity(state);
  const ctx = ctxOf(state, { activity });
  const commands = operationsFor(ctx).filter((op) => op.id.startsWith('command:'));
  expect(commands.map((op) => viewOf(op, ctx))).toEqual([
    expect.objectContaining({ label: 'executar dev', target: 'hive · #11', isDisabled: false }), expect.objectContaining({ label: 'executar test', isDisabled: false }),
  ]);
  commands[0].run?.(ctx);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/activities/a-I11/run', expect.objectContaining({ method: 'POST', body: JSON.stringify({ command: 'dev' }) })));
  const gone = { ...build, worktreeGone: true as const };
  const goneCtx = ctxOf(stateOf([gone], { commands: { hive: ['dev'] } }), { activity: { ...activity, task: gone } });
  expect(operationsFor(goneCtx).filter((op) => op.id.startsWith('command:')).map((op) => viewOf(op, goneCtx).isDisabled)).toEqual([true]);
});

test('parar todas and excluir atividade… list only when the task allows them and open their confirm through nav.dialog; dividir only on the shown activity (#584)', () => {
  const idle = task('11', 'Build', { worktree: '/w/11' });
  const state = stateOf([idle]);
  const activity = taskActivity(state);
  const ctx = ctxOf(state, { activity });
  expect(operationsFor(ctx).filter((op) => op.group === 'activity').map((op) => op.id)).toEqual(['activity.newSession', 'activity.diff', 'activity.showPr', 'activity.delete']);
  operationsFor(ctx).find((op) => op.id === 'activity.delete')?.run?.(ctx);
  expect(ctx.nav.dialog).toHaveBeenCalledWith({ kind: 'delete', task: bareTask(idle) }); // #629: the task as stored, its worktree on the activity
});

test('a workspace\'s local activity lists nova sessão › and dividir only; the task-only operations are not listed (#584, #590)', async () => {
  const state = stateOf([]);
  const [local] = activitiesOf(state);
  const ctx = ctxOf(state, { activity: local, isShown: true });
  const ops = operationsFor(ctx).filter((op) => op.group === 'activity');
  expect(ops.map((op) => text(op, ctx))).toEqual(['nova sessão · hive', 'dividir com o mesmo tipo · hive']);
  ops[0].children?.(ctx)[0].run?.(ctx);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/activities/local%3Ahive/sessions', expect.objectContaining({ method: 'POST' })));
});

test('a terminal focus leads with fechar tab and limpar o terminal, named after the run; a task focus lists only what the task allows (#584)', () => {
  const at = '2026-09-28T10:00:00.000Z';
  const build = task('11', 'Build', { worktree: '/w/11' });
  const state = stateOf([build], { terminals: [{ terminalId: 'W2', activityId: activityIdOf('I11'), startedAt: at, cwd: '/repo' }] });
  const terminal = ctxOf(state, { focus: { kind: 'terminal', run: { ptyId: 'W2', label: 'Terminal', kind: 'terminal' } } });
  const focusOf = (ctx: OperationContext): string[] => operationsFor(ctx).filter((op) => op.group === 'focus').map((op) => text(op, ctx));
  expect(focusOf(terminal)).toEqual(['fechar tab · Terminal', 'limpar o terminal · Terminal']);
  const local = ctxOf(state, { focus: { kind: 'terminal', run: { ptyId: 'W3', label: 'Terminal 2', kind: 'terminal' } } });
  expect(focusOf(local)).toEqual(['fechar tab · Terminal 2', 'limpar o terminal · Terminal 2']); // a workspace\'s local terminal has no task (#590)
  expect(focusOf(ctxOf(state, { focus: { kind: 'task', task: build } }))).toEqual(['começar sozinho · #11']);
  const waiting = { ...build, approval: { since: at } };
  expect(focusOf(ctxOf(stateOf([waiting]), { focus: { kind: 'task', task: waiting } }))).toEqual(['enviar feedback… · #11', 'aprovar · #11', 'começar sozinho · #11']);
});

test('enviar feedback… lists on a task in a manual gate with no session at all, as on any task awaiting approval (#685)', () => {
  const gated = task('11', 'Build', { stage: 'gate', approval: { since: '2026-09-28T10:00:00.000Z' } });
  const state = stateOf([gated], { stages: [{ name: 'gate', from: { board: ['Ready'] }, approval: true }] });
  const ctx = ctxOf(state, { focus: { kind: 'task', task: gated } });
  expect(operationsFor(ctx).filter((op) => op.group === 'focus').map((op) => op.id)).toEqual(['focus.feedback', 'focus.approve', 'focus.autoStart']);
});

test('enviar feedback… and aprovar are not listed while a session of the task is live: the user answers there (#829)', () => {
  const pending = task('11', 'Build', { approval: { since: '2026-09-28T10:00:00.000Z' } });
  const state = stateOf([pending], { workers: [{ id: 's1', activityId: activityIdOf('I11'), status: 'waiting', runId: 'W1', freeSession: true }] });
  const ctx = ctxOf(state, { focus: { kind: 'task', task: pending } });
  expect(operationsFor(ctx).filter((op) => op.group === 'focus').map((op) => op.id)).toEqual(['focus.autoStart']);
});

test('the order is focus › activity › global, and a focus operation calls what its tab or menu calls (#584)', async () => {
  const build = task('11', 'Build', { worktree: '/w/11', approval: { since: '2026-09-28T10:00:00.000Z' } });
  const state = stateOf([build]);
  const activity = taskActivity(state);
  const onTask = ctxOf(state, { activity, focus: { kind: 'task', task: build } });
  const groups = operationsFor(onTask).map((op) => op.group);
  expect(groups.filter((group, i) => group !== groups[i - 1])).toEqual(['focus', 'activity', 'global']);
  operationsFor(onTask).find((op) => op.id === 'focus.approve')?.run?.(onTask);
  operationsFor(onTask).find((op) => op.id === 'focus.feedback')?.run?.(onTask);
  expect(onTask.nav.dialog).toHaveBeenCalledWith({ kind: 'feedback', task: bareTask(build) }); // #629: the task as stored
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/activities/a-I11/approve', expect.objectContaining({ method: 'POST' })));
  const clear = vi.fn();
  const untrack = trackTerminal('W2', { clear } as unknown as Terminal);
  const onTerminal = ctxOf(state, { focus: { kind: 'terminal', run: { ptyId: 'W2', label: 'Terminal', kind: 'terminal' } } });
  for (const id of ['focus.closeTab', 'focus.clear']) operationsFor(onTerminal).find((op) => op.id === id)?.run?.(onTerminal);
  untrack();
  expect(onTerminal.nav.closeTab).toHaveBeenCalledWith('W2');
  expect(clear).toHaveBeenCalled();
});

test('a → page holds the row task\'s focus operations and, on an activity, its group targeted at it; never the global ones (#584)', () => {
  const build = task('11', 'Build', { worktree: '/w/11' });
  const plan = task('12', 'Plan');
  const state = stateOf([build, plan]);
  const activity = taskActivity(state);
  const onTask = itemPage(ctxOf(state), plan);
  expect(onTask.operations.map((op) => text(op, onTask.ctx))).toEqual(['começar sozinho · #12']);
  const onActivity = itemPage(ctxOf(state), build, activity);
  expect(onActivity.operations.map((op) => text(op, onActivity.ctx))).toEqual(['começar sozinho · #11', 'nova sessão · #11', 'diff · #11', 'mostrar PR · #11', 'excluir atividade… · #11']);
});

test('a focus operation reads the task from the State, not the copy taken when the search opened: começar sozinho posts the current toggle (#584)', async () => {
  const stale = task('11', 'Build', { worktree: '/w/11' });
  const fresh = { ...stale, auto: false as const };
  const ctx = ctxOf(stateOf([fresh]), { focus: { kind: 'task', task: stale } });
  const auto = operationsFor(ctx).find((op) => op.id === 'focus.autoStart');
  expect(auto?.checked?.(ctx)).toBe(false);
  auto?.run?.(ctx);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/tasks/I11/auto', expect.objectContaining({ body: JSON.stringify({ auto: true }) })));
});

test('mostrar PR opens the page of the task\'s next PR to merge, not its newest, and is listed disabled while the task has none (#592, #698, #758)', () => {
  const prs = [
    { url: 'https://github.com/acme/app/pull/7', state: 'merged' as const, slice: { k: 1, type: 'stacked' as const } },
    { url: 'https://github.com/acme/app/pull/8', state: 'open' as const, slice: { k: 2, type: 'stacked' as const } },
    { url: 'https://github.com/acme/app/pull/9', state: 'open' as const, slice: { k: 3, type: 'stacked' as const } },
  ];
  const build = task('11', 'Build', { worktree: '/w/11' });
  const state = stateOf([build], { activityRecords: [recordFor('I11', { prs })] }); // #629: the PRs are the record's
  const ctx = ctxOf(state, { activity: taskActivity(state) });
  const op = operationsFor(ctx).find((o) => o.id === 'activity.showPr') as Operation;
  expect(viewOf(op, ctx)).toEqual(expect.objectContaining({ label: 'mostrar PR', target: '#11', isDisabled: false }));
  op.run?.(ctx);
  expect(ctx.nav.openPr).toHaveBeenCalledWith(prs[1].url);
  const bare = stateOf([task('11', 'Build', { worktree: '/w/11' })]);
  const bareCtx = ctxOf(bare, { activity: taskActivity(bare) });
  expect(viewOf(operationsFor(bareCtx).find((o) => o.id === 'activity.showPr') as Operation, bareCtx).isDisabled).toBe(true);
});

test('a soon id is never listed: its key is only reserved (#585)', () => {
  const op = (shortcut: Operation['shortcut']): Operation => ({ id: 'x', group: 'global', shortcut, label: () => 'x', available: () => true });
  expect([isListed(op('nextTab')), isListed(op('toggleLeft')), isListed(op(undefined))]).toEqual([false, true, true]);
});

test('dividir o terminal na vertical and na horizontal list while the shown activity\'s focused group shows a run, each with its key, and do what the key does (#641)', () => {
  const build = task('11', 'Build', { worktree: '/w/11' });
  const state = stateOf([build], { workers: [{ id: 's1', activityId: activityIdOf('I11'), status: 'working', runId: 'W1' }] });
  const activity = taskActivity(state);
  const ctx = ctxOf(state, { activity, isShown: true, shownRun: 'W1' });
  const ops = operationsFor(ctx).filter((op) => op.id.startsWith('activity.splitTerminal'));
  expect(ops.map((op) => [text(op, ctx), op.shortcut])).toEqual([
    ['dividir o terminal na vertical · #11', 'splitTerminalVertical'], ['dividir o terminal na horizontal · #11', 'splitTerminalHorizontal'],
  ]);
  const pressed = vi.fn();
  const stop = onShortcutKey([['vertical', 'splitTerminalVertical'], ['horizontal', 'splitTerminalHorizontal']], pressed);
  for (const op of ops) op.run?.(ctx);
  stop();
  expect(pressed.mock.calls).toEqual([['vertical'], ['horizontal']]);
  expect(operationsFor(ctxOf(state, { activity, isShown: true })).some((op) => op.id.startsWith('activity.splitTerminal'))).toBe(false); // a diff or the console shown
});

test('a focused editor offers Git: Abrir Alterações on any file and Markdown: Abrir Preview on a markdown one, named after the file; each run opens its tab; with no changes opener, none (#697, #668)', () => {
  const state = stateOf([]);
  const on = (path: string): OperationContext => ctxOf(state, { focus: { kind: 'file', activityId: 'a-I11', path } });
  const focusOf = (ctx: OperationContext): string[] => operationsFor(ctx).filter((op) => op.group === 'focus').map((op) => text(op, ctx));
  expect(focusOf(on('docs/Plan.MD'))).toEqual(['Markdown: Abrir Preview · Plan.MD', 'Git: Abrir Alterações · Plan.MD']);
  expect(focusOf(on('notes.markdown'))).toEqual(['Markdown: Abrir Preview · notes.markdown', 'Git: Abrir Alterações · notes.markdown']);
  expect(focusOf(on('src/a.ts'))).toEqual(['Git: Abrir Alterações · a.ts']);
  expect(focusOf(on('docs/page.mdx'))).toEqual(['Git: Abrir Alterações · page.mdx']);
  const ctx = on('docs/plan.md');
  operationsFor(ctx).find((op) => op.id === 'focus.markdownPreview')?.run?.(ctx);
  operationsFor(ctx).find((op) => op.id === 'focus.openChanges')?.run?.(ctx);
  expect(ctx.nav.openPreview).toHaveBeenCalledWith('a-I11', 'docs/plan.md');
  expect(ctx.nav.openChanges).toHaveBeenCalledWith('a-I11', 'docs/plan.md');
  const bare = ctxOf(state, { focus: { kind: 'file', activityId: 'a-I11', path: 'src/a.ts' }, nav: { ...navOf(), openChanges: undefined } });
  expect(focusOf(bare)).toEqual([]);
});

test('nova sessão › lists every agent; one boot did not find is disabled and named off PATH (#931)', () => {
  const build = task('11', 'Build', { worktree: '/w/11' });
  const state = stateOf([build], { workers: [{ id: 's1', activityId: activityIdOf('I11'), status: 'working', runId: 'W1' }] });
  const ctx = ctxOf(state, { activity: taskActivity(state), isShown: true, agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: false }] });
  const picks = operationsFor(ctx).find((op) => op.id === 'activity.newSession')?.children?.(ctx) ?? [];
  expect(picks.map((op) => [op.label(ctx), op.disabled?.(ctx) ?? false])).toEqual([['claude', false], ['codex · fora do PATH', true]]);
});
