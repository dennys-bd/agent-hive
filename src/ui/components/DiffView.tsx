import { useId, useState } from 'react';
import { taskLabel } from '../../tasks';
import type { DiffScope, FileDiff } from '../../types';
import { DiffBar, latestCheckpoint } from '@/components/DiffBar';
import { markFile } from '@/components/review-actions';
import { ReviewBody } from '@/components/ReviewBody';
import { ReviewContext, type ReviewPane } from '@/components/review-context';
import { type CommentTarget, ReviewSurfaceContext } from '@/components/review-surface';
import { sessionsSurface } from '@/components/sessions-surface';
import { type DiffTab, useOpenFile } from '@/components/terminal-tabs';
import { type DiffState, useTaskDiff } from '@/hooks/use-task-diff';
import { useDiffLayout, useFileNav, useLineSelection } from '@/hooks/use-diff-pane';
import { useReview } from '@/hooks/use-review';
import { useReviewSubmit } from '@/hooks/use-review-submit';
import { type MessageKey, t } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { taskReview } from '@/lib/review-events';
import { defaultSessionOf, EMPTY_REVIEW, isReviewedIn, reviewSessions, selectionAnchor } from '@/lib/review-view';

/** How a diff tab's scope reads (#270, #591): after the task in the tab's label, and in its strip. */
export const DIFF_SCOPE_KEY: Record<DiffScope, MessageKey> = {
  stage: 'terminal.panel.kind.diffStage', worktree: 'terminal.panel.kind.diffWorktree', commit: 'terminal.panel.kind.diffCommit', checkpoint: 'terminal.panel.kind.diffCheckpoint',
};
const NO_FILES: FileDiff[] = [];

// The pane's own sends in flight (#591): their message is stored failed until its delivery settles, which is not a failure yet
function useTracked(): Pick<ReviewPane, 'isSending' | 'track'> {
  const [sending, setSending] = useState(0);
  return {
    isSending: sending > 0,
    track: <T,>(request: Promise<T>): Promise<T> => {
      setSending((n) => n + 1);
      return request.finally(() => setSending((n) => n - 1));
    },
  };
}

// Loading, the route's error, or nothing changed (#270)
function DiffStatus({ state }: { state: DiffState }) {
  if (state.status === 'loading') return <p className="p-2 text-muted-foreground">{t('diff.loading')}</p>;
  if (state.status === 'error') return <p role="alert" className="p-2 text-destructive">{state.message}</p>;
  return <p className="p-2 text-muted-foreground">{t('diff.empty')}</p>;
}

interface DiffViewProps { tab: DiffTab; label: string; active: boolean; activity: TaskActivity; onScope(scope: DiffScope, checkpoint?: number): void }

/** A task's diff pane in the activity space (#270, #591): the bar, then the file list and the files, through the sessions surface (#592). Section
 * ids come from useId, so two panes never share one. Collapsed like PtyTab while another tab shows. */
export function DiffView({ tab, label, active, activity, onScope }: DiffViewProps) {
  const checkpoint = tab.scope === 'checkpoint' ? tab.checkpoint ?? latestCheckpoint(activity.activity) : undefined; // #619
  const { state, refresh } = useTaskDiff(activity.activity.id, tab.scope, active, checkpoint); // the live activity's worktree (#629)
  const openFile = useOpenFile(); // abrir arquivo: the file in this activity's editor pane (#717)
  const files = state.status === 'ready' ? state.diff.files : NO_FILES;
  const [layout, setLayout] = useDiffLayout();
  const prefix = useId();
  const sectionId = (path: string): string => `${prefix}${path}`;
  const reviewKey = taskReview(tab.task);
  const { review, refresh: reread } = useReview(reviewKey);
  const isReviewed = (file: FileDiff): boolean => isReviewedIn(review, tab.scope, file);
  const mark = (file: FileDiff, reviewed: boolean): void => {
    void markFile(reviewKey, { scope: tab.scope, path: file.path, hash: file.hash, reviewed }).then(reread);
  };
  const nav = useFileNav({ files, sectionId, isReviewed, mark });
  const lines = useLineSelection();
  const [editing, setEditing] = useState<CommentTarget>();
  const boxAnchor = selectionAnchor(files, tab.scope, lines.box);
  const target = editing ?? (boxAnchor === undefined ? undefined : { anchor: boxAnchor });
  const closeBox = (): void => { setEditing(undefined); lines.close(); };
  const submit = useReviewSubmit(reviewKey, review, reread);
  const tracked = useTracked();
  const sessions = reviewSessions(activity);
  const file = review ?? EMPTY_REVIEW;
  const pane: ReviewPane = {
    reviewKey, scope: tab.scope, task: taskLabel(activity.task), review: file, sessions, defaultSession: defaultSessionOf(file, sessions),
    refresh: reread, edit: (next) => { lines.close(); setEditing(next); }, ...tracked,
  };
  return (
    <section
      aria-label={label}
      style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }}
      className="flex min-h-0 min-w-0 flex-col text-xs"
    >
      <DiffBar scope={tab.scope} checkpoint={checkpoint} task={activity.task} activity={activity.activity} diff={state.status === 'ready' ? state.diff : undefined} layout={layout} reviewed={files.filter(isReviewed).length} hideReviewed={nav.hideReviewed} onScope={onScope} onLayout={setLayout} onRefresh={refresh} onHideReviewed={nav.setHideReviewed} />
      {files.length > 0 ? (
        <ReviewContext.Provider value={pane}>
          <ReviewSurfaceContext.Provider value={sessionsSurface(pane, { openFile: (path) => { openFile?.(activity.task.item.itemId, path); }, reviewed: isReviewed, mark, submit })}>
            <ReviewBody files={files} layout={layout} nav={nav} sectionId={sectionId} lines={lines} target={target} onCloseBox={closeBox} />
          </ReviewSurfaceContext.Provider>
        </ReviewContext.Provider>
      ) : <DiffStatus state={state} />}
    </section>
  );
}
