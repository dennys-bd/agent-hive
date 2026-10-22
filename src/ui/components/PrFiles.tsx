import type { FileDiff } from '../../types';
import { Conversation } from '@/components/Conversation';
import { ReviewBody } from '@/components/ReviewBody';
import type { ChangesLoad, PrLoad } from '@/hooks/use-pr';
import type { PrReviewView } from '@/hooks/use-pr-view';
import { t } from '@/i18n';
import type { PrView } from '@/lib/pr-view';
import { prConversation } from '@/lib/surface';

/** A PR's first read, or its error (#592). */
export function PrStatus({ load }: { load: PrLoad | ChangesLoad }) {
  if (load.status === 'error') return <p role="alert" className="p-2 text-destructive">{load.message}</p>;
  return <p className="p-2 text-muted-foreground">{t('diff.loading')}</p>;
}

// Conversations whose file left the PR's diff (#592): a group at the top, each under its path
function OutOfDiff({ pr, files }: { pr: PrView; files: FileDiff[] }) {
  const gone = pr.threads.filter((thread) => !files.some((f) => f.path === thread.anchor.path));
  if (gone.length === 0) return null;
  return (
    <section aria-label={t('pr.outOfDiff')} className="border-b px-2 py-1">
      <h3 className="text-muted-foreground text-xs">{t('pr.outOfDiff')}</h3>
      {gone.map((thread) => (
        <div key={thread.id}>
          <p className="font-mono text-muted-foreground text-xs">{thread.anchor.path}</p>
          <Conversation conversation={prConversation(thread, pr.viewer)} isOutdated={thread.outdated} />
        </div>
      ))}
    </section>
  );
}

/** A PR's files (#592, #758): ReviewBody as the diff pane draws it, GitHub on the other side, the conversations whose file left the diff at
 * its top. The caller provides the review surface. */
export function PrFiles({ pr, view }: { pr: PrView; view: PrReviewView }) {
  return (
    <ReviewBody
      files={view.files} layout={view.layout} nav={view.nav} sectionId={view.sectionId} lines={view.lines} target={view.target}
      onCloseBox={view.closeBox} top={<OutOfDiff pr={pr} files={view.files} />}
    />
  );
}
