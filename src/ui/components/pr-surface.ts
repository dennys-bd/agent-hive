// The PR's review surface (#592, #758): GitHub's conversations and the PR's review file, through the PR routes. No session takes part; reviews go from the page's popover (#758).
import type { FileDiff, PrReviewFile } from '../../types';
import { prAddDraft, prComment, prDropDraft, prEditDraft, prReply, prResolve } from '@/components/pr-actions';
import type { CommentTarget, ReviewSurface } from '@/components/review-surface';
import { t } from '@/i18n';
import { prConversation } from '@/lib/surface';
import type { PrView } from '@/lib/pr-view';

/** What a PR view hands its surface (#592). reread: the file read again (a local write); after: the PR and the file (a write to GitHub). */
export interface PrSurfaceInput {
  pr: PrView; review: PrReviewFile;
  reviewed(file: FileDiff): boolean; mark(file: FileDiff, reviewed: boolean): void; edit(target: CommentTarget): void; reread(): void; after(): void;
}

export function prSurface({ pr, review, reviewed, mark, edit, reread, after }: PrSurfaceInput): ReviewSurface {
  const { url } = pr;
  const head = pr.changesHead ?? pr.head; // a line comment goes with the diff's head
  const toGithub = (request: Promise<unknown>): Promise<void> => request.then(after);
  const toFile = (request: Promise<unknown>): Promise<void> => request.then(reread);
  return {
    footer: t('pr.footer'), readOnly: pr.state !== 'open',
    conversations: (file) => pr.threads.filter((thread) => thread.anchor.path === file.path).map((thread) => prConversation(thread, pr.viewer)),
    drafts: (path) => review.drafts.filter((draft) => draft.anchor.path === path),
    counts: { drafts: review.drafts.length, open: pr.threads.filter((thread) => !thread.resolved).length },
    reviewed, mark, edit,
    // An edited draft sent now leaves the review, once GitHub took it
    comment: (anchor, text, { replaces } = {}) => toGithub(prComment(url, { head, anchor, text })
      .then((sent) => (sent === undefined || replaces === undefined ? undefined : prDropDraft(url, replaces)))),
    addDraft: (anchor, text) => toFile(prAddDraft(url, { anchor, text })),
    editDraft: (id, text) => toFile(prEditDraft(url, id, text)),
    reply: (id, text) => toGithub(prReply(url, id, text)),
    resolve: (id, resolved) => toGithub(prResolve(url, id, resolved)),
  };
}
