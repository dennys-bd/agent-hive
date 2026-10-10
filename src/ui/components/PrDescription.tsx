import type { PrData } from '../../types';
import { Editable, fieldSaver } from '@/components/Editable';
import { IssueMarkdown } from '@/components/IssueMarkdown';
import { prPath } from '@/hooks/use-pr';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';

const MUTED = 'text-muted-foreground';

/** Whether the page may edit the PR's title and description (#758): an open PR GitHub says the login can update. */
export const canEditPr = (pr: PrData): boolean => pr.state === 'open' && pr.canEdit;

// A save of the PR's title or description (#758), as the issue page's: with the updatedAt the edit started on; a 409 says the PR changed
const saverOf = (pr: PrData, onChanged: () => Promise<void>): ReturnType<typeof fieldSaver> => fieldSaver(prPath(pr.url), t('pr.changed'), onChanged);

/** The PR's title (#758, handoff 03 "Topo"): 20px/600 with edit, as the issue page's; plain on a PR the page may not edit. */
export function PrTitle({ pr, onChanged }: { pr: PrData; onChanged(): Promise<void> }) {
  const heading = <h1 className="font-semibold text-[20px] leading-[26px] [text-wrap:pretty]">{pr.title}</h1>;
  if (!canEditPr(pr)) return heading;
  return <Editable label={t('issue.title')} value={pr.title} updatedAt={pr.updatedAt} isMultiline={false} changed={t('pr.changed')} onSave={saverOf(pr, onChanged)('title')}>{heading}</Editable>;
}

/** description (#758): the PR's body below its line, with its author and date, rendered as the issue page renders one; edit in place on a
 * PR the page may edit. */
export function PrDescription({ pr, onChanged }: { pr: PrData; onChanged(): Promise<void> }) {
  const body = <div className="text-[13px] leading-[21px]"><IssueMarkdown text={pr.body} /></div>;
  return (
    <section aria-label={t('pr.description')} className="flex max-w-[680px] flex-col gap-2">
      <p className="flex gap-2 text-xs">
        <span className="font-medium text-foreground">{t('pr.description')}</span>
        <span className={MUTED}>{`${pr.author} · ${relativeTime(pr.createdAt)}`}</span>
      </p>
      {canEditPr(pr) ? <Editable label={t('pr.description')} value={pr.body} updatedAt={pr.updatedAt} isMultiline changed={t('pr.changed')} onSave={saverOf(pr, onChanged)('body')}>{body}</Editable> : body}
    </section>
  );
}
