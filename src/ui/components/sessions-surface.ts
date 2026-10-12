// The diff pane's surface (#591, #592): the task's review file and sessions, through the review routes.
import { type FileDiff, isDesignAnchor, type ReviewAnchor, type ThreadAnchor } from '../../types';
import { chooseDefaultSession, dropDraft, editDraft, replyTo, resolveThread, retryMessage, saveDraft, sendComment } from '@/components/review-actions';
import { type ReviewPane, sessionName } from '@/components/review-context';
import type { ReviewSurface } from '@/components/review-surface';
import type { ReviewSubmit } from '@/hooks/use-review-submit';
import { t } from '@/i18n';
import { onFile } from '@/lib/review-view';
import { sessionConversation, type SurfaceAnchor } from '@/lib/surface';

/** What the diff pane adds to its pane (#592): the reviewed marks as its file nav reads them, and its enviar revisão. */
// openFile: abrir arquivo (#591), the file in the activity's editor pane, at its top: the file header carries no line (#717)
export interface SessionsView { openFile(path: string): void; reviewed(file: FileDiff): boolean; mark(file: FileDiff, reviewed: boolean): void; submit: Pick<ReviewSubmit, 'failed' | 'unsaved' | 'canSubmit' | 'submit'> }

const errorsOf = ({ failed, unsaved }: SessionsView['submit'], sessions: ReviewPane['sessions']): string[] => [
  ...failed.map((s) => t('review.notDeliveredTo', { session: sessionName(s, sessions) })), ...unsaved.map((s) => t('review.notSavedTo', { session: sessionName(s, sessions) })),
];

const isLine = (item: { anchor: ThreadAnchor }): boolean => !isDesignAnchor(item.anchor);

/** The diff pane's surface (#592): what #591's components did through the pane, now behind the shared shape. */
export function sessionsSurface(pane: ReviewPane, view: SessionsView): ReviewSurface {
  const { taskId, scope, review } = pane;
  const withScope = (anchor: SurfaceAnchor): ReviewAnchor => ({ ...anchor, scope });
  const reread = (): void => pane.refresh();
  return {
    footer: t('review.footer'), readOnly: false,
    conversations: (file) => review.threads.filter(onFile(scope, file.path)).map((thread) => sessionConversation(thread, file, pane.sessions)),
    drafts: (path) => review.drafts.filter(onFile(scope, path)),
    counts: { drafts: review.drafts.filter(isLine).length, open: review.threads.filter((thread) => isLine(thread) && !thread.resolved).length },
    reviewed: view.reviewed, mark: view.mark, edit: pane.edit,
    comment: (anchor, text, { to, mentions, replaces } = {}) => pane.track(sendComment(taskId, { anchor: withScope(anchor), text, ...(mentions === undefined ? { to } : { mentions }) }))
      .then(() => (replaces === undefined ? undefined : dropDraft(taskId, replaces))) // an edited draft sent now leaves the review
      .then(reread),
    addDraft: (anchor, text, session = pane.defaultSession) => saveDraft(taskId, { anchor: withScope(anchor), text, session }).then(reread),
    editDraft: (id, text, session = pane.defaultSession) => editDraft(taskId, id, { text, session }).then(reread),
    reply: (id, text, mentions) => pane.track(replyTo(taskId, id, { text, ...(mentions === undefined ? {} : { mentions }) })).then(reread),
    resolve: (id, resolved) => resolveThread(taskId, id, resolved).then(reread),
    submit: { canSubmit: view.submit.canSubmit, submit: view.submit.submit, errors: errorsOf(view.submit, pane.sessions) },
    openFile: (file) => view.openFile(file.path),
    sessions: {
      defaultSession: pane.defaultSession, isSending: pane.isSending,
      chooseDefault: (session) => void chooseDefaultSession(taskId, session).then(reread),
      retry: (id, message) => void pane.track(retryMessage(taskId, id, message)).then(reread),
    },
  };
}
