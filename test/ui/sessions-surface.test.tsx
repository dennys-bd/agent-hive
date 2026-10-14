import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReviewPane } from '@/components/review-context';
import { sessionsSurface } from '@/components/sessions-surface';
import { setLanguage } from '@/i18n';
import { EMPTY_REVIEW } from '@/lib/review-view';
import type { FileDiff, ReviewDraft, ReviewThread } from '../../src/types';
import { jsonResponse } from '../fakes';

const SESSION = 'abcdef12-0000-4000-8000-000000000000';
const AT = '2026-09-30T10:00:00.000Z';
const FILE: FileDiff = { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [
  { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 },
] }] };
const ANCHOR = { scope: 'worktree' as const, path: 'src/a.ts', side: 'new' as const, start: 2, end: 2, excerpt: ['2'] };
const THREAD: ReviewThread = {
  id: 'T1', anchor: { ...ANCHOR, excerpt: ['was 2'] }, participants: [SESSION],
  messages: [{ id: 'M1', author: 'user', at: AT, text: 'why?', to: [SESSION], mentions: [SESSION], failed: true, pending: [SESSION] }],
};
const DRAFT: ReviewDraft = { id: 'D1', anchor: ANCHOR, session: SESSION, text: 'later' };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const paneOf = (): ReviewPane => ({
  taskId: 'I1', scope: 'worktree', task: '#1 Task 1', review: { ...EMPTY_REVIEW, threads: [THREAD], drafts: [DRAFT] },
  sessions: [{ id: SESSION, status: 'working', lastUsedAt: AT, agent: 'claude' }], defaultSession: SESSION, refresh: vi.fn(), edit: vi.fn(), isSending: false, track: (request) => request,
});
const VIEW = { openFile: vi.fn(), reviewed: () => false, mark: vi.fn(), submit: { failed: [SESSION], unsaved: [], canSubmit: true, submit: vi.fn() } };

test('the sessions surface draws the task\'s review: você as author, outdated by its excerpt, respondendo from a working session (#592)', () => {
  const surface = sessionsSurface(paneOf(), VIEW);
  expect(surface.conversations(FILE)).toEqual([{
    id: 'T1', anchor: THREAD.anchor, outdated: true, resolved: false, participants: [SESSION], replying: [SESSION],
    messages: [{ id: 'M1', author: { kind: 'you' }, at: AT, text: 'why?', mentions: [SESSION], failed: true }],
  }]);
  expect([surface.drafts('src/a.ts'), surface.drafts('b.ts')]).toEqual([[DRAFT], []]);
  expect(surface.counts).toEqual({ drafts: 1, open: 1 });
  expect([surface.readOnly, surface.footer, surface.sessions?.defaultSession]).toEqual([false, 'revisão', SESSION]);
  expect(surface.submit?.errors).toEqual(['não entregue a claude abcdef12']);
});

test('its writes go through the review routes with the pane\'s scope; an edited draft sent now is dropped after it, then the file is read again (#592)', async () => {
  const pane = paneOf();
  const surface = sessionsSurface(pane, VIEW);
  const { scope: _scope, ...lines } = ANCHOR;
  await surface.comment(lines, 'hi', { to: [SESSION], replaces: 'D1' });
  await surface.reply('T1', 'and?');
  const calls = fetchMock.mock.calls.map(([url, init]) => [init?.method, url, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);
  expect(calls).toEqual([
    ['POST', '/tasks/I1/review/threads', { anchor: ANCHOR, text: 'hi', to: [SESSION] }],
    ['DELETE', '/tasks/I1/review/drafts/D1', undefined],
    ['POST', '/tasks/I1/review/threads/T1/messages', { text: 'and?' }],
  ]);
  expect(pane.refresh).toHaveBeenCalledTimes(2);
});

const DESIGN = { path: 'src/a.ts', viewport: 'desktop' as const, theme: 'dark' as const, tweaks: {}, pin: 1, kind: 'area' as const, rect: { x: 0, y: 0, width: 1, height: 1 } };

test('design comments stay out of the diff pane: its conversations, drafts and counts take only line anchors (#111)', () => {
  const review = { ...EMPTY_REVIEW, threads: [THREAD, { ...THREAD, id: 'T2', anchor: DESIGN }], drafts: [DRAFT, { ...DRAFT, id: 'D2', anchor: DESIGN }] };
  const surface = sessionsSurface({ ...paneOf(), review }, VIEW);
  expect(surface.conversations(FILE).map((c) => c.id)).toEqual(['T1']);
  expect(surface.drafts('src/a.ts')).toEqual([DRAFT]);
  expect(surface.counts).toEqual({ drafts: 1, open: 1 });
});
