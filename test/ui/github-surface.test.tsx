import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { CommentBox } from '@/components/CommentBox';
import { Conversation } from '@/components/Conversation';
import { DiffFile } from '@/components/DiffFile';
import { DiffFooter } from '@/components/DiffFooter';
import { type ReviewSurface, ReviewSurfaceContext } from '@/components/review-surface';
import { setLanguage } from '@/i18n';
import type { SurfaceConversation } from '@/lib/surface';
import type { FileDiff } from '../../src/types';

// A surface as the PR page builds it (#592): GitHub on the other side, no sessions, a general comment
const FILE: FileDiff = { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [
  { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 },
] }] };
const AT = '2026-09-30T10:00:00.000Z';
const TARGET = { anchor: { path: 'src/a.ts', side: 'new' as const, start: 2, end: 2, excerpt: ['2'] } };
const conversation = (extra: Partial<SurfaceConversation> = {}): SurfaceConversation => ({
  id: 'T1', anchor: { path: 'src/a.ts', side: 'new', start: 2, end: 2 }, outdated: false, resolved: false,
  messages: [{ id: 'C1', author: { kind: 'login', login: 'bia' }, at: AT, text: 'why?' }, { id: 'C2', author: { kind: 'you' }, at: AT, text: 'because' }], ...extra,
});
function github(extra: Partial<ReviewSurface> = {}): ReviewSurface {
  return {
    footer: 'revisão do PR', readOnly: false, conversations: () => [conversation()], drafts: () => [], counts: { drafts: 0, open: 1 },
    reviewed: () => false, mark: vi.fn(), edit: vi.fn(), comment: vi.fn(async () => undefined), addDraft: vi.fn(async () => undefined),
    editDraft: vi.fn(async () => undefined), reply: vi.fn(async () => undefined), resolve: vi.fn(async () => undefined),
    submit: { canSubmit: false, submit: vi.fn(), errors: [] }, ...extra,
  };
}
const LINES = { isDragging: false, select: vi.fn(), begin: vi.fn(), extend: vi.fn(), comment: vi.fn(), close: vi.fn() };
const inGithub = (surface: ReviewSurface, ui: ReactNode) => render(<ReviewSurfaceContext.Provider value={surface}>{ui}</ReviewSurfaceContext.Provider>);
beforeEach(() => setLanguage('pt'));

test('on GitHub the box has no session picker and no mentions: enviar takes the text alone (#592)', async () => {
  const user = userEvent.setup();
  const surface = github();
  inGithub(surface, <CommentBox target={TARGET} onClose={vi.fn()} />);
  const box = screen.getByRole('group', { name: 'linha 2' });
  expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringMatching(/^enviar/), expect.stringMatching(/^adicionar à revisão/), 'cancelar']);
  await user.type(within(box).getByRole('textbox', { name: 'comentário' }), 'hi @');
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.click(within(box).getByRole('button', { name: 'enviar' }));
  expect(surface.comment).toHaveBeenCalledWith(TARGET.anchor, 'hi @', {});
});

test('a GitHub conversation names its authors by login and the viewer você, shows no delivery status, replies with ↵, and says GitHub holds more (#592)', async () => {
  const user = userEvent.setup();
  const surface = github();
  const [first, second] = conversation().messages;
  inGithub(surface, <Conversation conversation={conversation({ more: true, messages: [{ ...first, failed: true }, second] })} />);
  const group = screen.getByRole('group', { name: 'conversa' });
  expect(within(group).getByText('bia')).toHaveClass('font-medium');
  expect(within(group).getByText('você')).toHaveClass('font-medium');
  expect(group).not.toHaveTextContent('não entregue');
  expect(group).toHaveTextContent('mais comentários no GitHub');
  await user.type(within(group).getByRole('textbox', { name: 'responder' }), 'ok{Enter}');
  expect(surface.reply).toHaveBeenCalledWith('T1', 'ok', undefined);
});

test('read only: no + on a line, no reply, no resolver, no editar, no abrir arquivo; a file-level conversation sits at the top with no line (#592)', () => {
  const fileLevel = conversation({ id: 'T2', fileLevel: true, anchor: { path: 'src/a.ts', side: 'new', start: 0, end: 0 } });
  const surface = github({ readOnly: true, conversations: () => [conversation(), fileLevel], drafts: () => [{ id: 'D1', anchor: TARGET.anchor, text: 'later' }] });
  inGithub(surface, <DiffFile file={FILE} id="f1" layout="unified" collapsed={false} isReviewed={false} onToggle={vi.fn()} onReviewed={vi.fn()} lines={LINES} onCloseBox={vi.fn()} />);
  const section = screen.getByRole('region', { name: 'src/a.ts' });
  expect(within(section).queryAllByRole('button', { name: /^comentar/ })).toEqual([]);
  expect(within(section).queryByRole('textbox')).toBeNull();
  for (const name of ['resolver', 'editar', 'abrir arquivo']) expect(within(section).queryByRole('button', { name })).toBeNull();
  const [top, onLine] = within(section).getAllByRole('group', { name: 'conversa' });
  expect(top.closest('tr')).toBeNull();
  expect(top).not.toHaveTextContent('linha');
  expect(onLine.closest('tr')).not.toBeNull();
  expect(onLine).toHaveTextContent('linha 2');
});

test('the footer names the PR review, has no sessão padrão and no comentário geral (#592, #758)', async () => {
  const user = userEvent.setup();
  const surface = github({ submit: { canSubmit: true, submit: vi.fn(), errors: ['Head sha can\'t be blank'] } });
  inGithub(surface, <DiffFooter />);
  const footer = screen.getByRole('group', { name: 'revisão do PR' });
  expect(within(footer).queryByRole('button', { name: 'sessão' })).toBeNull();
  expect(within(footer).getByRole('alert')).toHaveTextContent('Head sha can\'t be blank');
  expect(within(footer).queryByRole('textbox', { name: 'comentário geral' })).toBeNull();
  await user.click(within(footer).getByRole('button', { name: /enviar revisão/ }));
  expect(surface.submit?.submit).toHaveBeenCalled();
});
