import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { plainLines, rowTails, useSetupLog } from '@/hooks/use-setup-log';
import type { SetupRow } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

const ESC = '\x1b';
const AT = '2026-10-19T10:00:00.000Z';
const CONSOLE = 'setup:I9';
const step = (label: string, status: SetupRow['status'], extra: Partial<SetupRow> = {}): SetupRow => ({ kind: 'step', status, label, header: `RUN ${label}`, ...extra });
const ROWS: SetupRow[] = [
  { kind: 'worktree', status: 'done', durationMs: 1200 }, { kind: 'branch', status: 'done', branch: 'hive/9-x', base: 'origin/main' },
  step('pnpm install', 'done', { durationMs: 34_000 }), step('pnpm build', 'running', { startedAt: AT }), step('pnpm test', 'queued'),
];
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => resetFakes());
afterEach(() => vi.unstubAllGlobals());

test('plainLines drops the SGR codes, keeps a redrawn line\'s last drawing and no trailing blank line (#390)', () => {
  expect(plainLines(`${ESC}[97m> RUN x${ESC}[0m\r\nProgress: 1\rProgress: 2\r\n\r\n`)).toEqual(['> RUN x', 'Progress: 2']);
  expect(plainLines('')).toEqual([]);
});

test('the output is cut at the step headers in order: a `> git …` or a RUN\'s own `> pkg@x build` opens no row; the tail is the last 4 lines (#390)', () => {
  const text = [
    `${ESC}[97m> git -C /repo worktree add -b hive/9-x -- /wt main${ESC}[0m`, `${ESC}[32mok 120ms${ESC}[0m`, `${ESC}[97m> git -C /wt rev-parse --absolute-git-dir${ESC}[0m`, `${ESC}[32mok 5ms${ESC}[0m`,
    `${ESC}[97m> RUN pnpm install${ESC}[0m`, 'Packages: +1734', 'Progress: resolved 1\rProgress: resolved 1734', 'done', `${ESC}[32mok 34000ms${ESC}[0m`,
    `${ESC}[97m> RUN pnpm build${ESC}[0m`, '> pkg@1.0.0 build', '> tsc', 'built',
  ].join('\r\n');
  expect(rowTails(text, ROWS)).toEqual([
    ['> git -C /repo worktree add -b hive/9-x -- /wt main', 'ok 120ms', '> git -C /wt rev-parse --absolute-git-dir', 'ok 5ms'],
    [],
    ['Packages: +1734', 'Progress: resolved 1734', 'done', 'ok 34000ms'],
    ['> RUN pnpm build', '> pkg@1.0.0 build', '> tsc', 'built'],
    [],
  ]);
});

test('a step a resume skipped printed nothing: the next header opens the next row (#390)', () => {
  const resumed = [...ROWS.slice(0, 2), step('pnpm install', 'done'), step('pnpm build', 'running', { startedAt: AT })];
  expect(rowTails('> git -C /wt rev-parse --absolute-git-dir\r\nok 5ms\r\n> RUN pnpm build\r\nbuilt\r\n', resumed))
    .toEqual([['> git -C /wt rev-parse --absolute-git-dir', 'ok 5ms'], [], [], ['> RUN pnpm build', 'built']]);
});

test('a live run is read over its pty socket as it comes; once it ends, the task\'s last run is read from the channel (#390)', async () => {
  const older = '── #9 · setup · 09:00:00 ──\r\n> RUN pnpm install\r\nold output\r\n';
  const last = `── #9 · setup · 10:00:00 ──\r\n> RUN pnpm install\r\nnew output\r\n${ESC}[31msetup failed at line 1 (RUN pnpm install): exit 1${ESC}[0m\r\n`;
  const views = [{ history: older, live: [{ ptyId: CONSOLE, header: '── #9 · setup · 10:00:00 ──\r\n' }], status: 'running' }, { history: `${older}${last}`, live: [], status: 'failed' }];
  const fetchMock = vi.fn(async (_url: string) => reply(views.shift()));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const { result } = renderHook(() => useSetupLog(CONSOLE, ROWS, true));
  await waitFor(() => expect(FakeWebSocket.all.map((s) => s.path)).toEqual(['/ptys/setup%3AI9/pty']));
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/console/setup?run=setup%3AI9');
  act(() => FakeWebSocket.all[0]?.receive('> git x\r\nok 1ms\r\n> RUN pnpm install\r\nadded 3\r\n'));
  expect(result.current[2]).toEqual(['> RUN pnpm install', 'added 3']);
  act(() => FakeWebSocket.all[0]?.end());
  await waitFor(() => expect(result.current[2]).toEqual(['> RUN pnpm install', 'new output', 'setup failed at line 1 (RUN pnpm install): exit 1']));
});
