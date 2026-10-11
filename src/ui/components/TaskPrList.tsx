import { useEffect, useState } from 'react';
import { prsOf } from '../../activities';
import { type PrLine, prGroups, prNumber, prRepo, repoName } from '../../pull-requests';
import type { PrChecks, State, Task } from '../../types';
import { Button } from '@/components/ui/button';
import { isChecksRead, prPath } from '@/hooks/use-pr';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';

const MUTED = 'text-muted-foreground';
type Mark = PrChecks['state'];
// The checks rollup in its status colour (#65); a running check asks nothing of the user, so it stays muted
const MARKS: Record<Mark, { glyph: string; tone: string }> = {
  success: { glyph: '✓', tone: 'text-working' }, failure: { glyph: '✗', tone: 'text-destructive' }, pending: { glyph: '●', tone: MUTED },
};

// Each open PR's checks state (#65), read once per list through the PR page's own route; no poll, the PR's page polls. A failed read (an
// unlisted repository answers 404) is no mark and no toast: the mark is decoration, the PR's own page shows the error
function usePrMarks(urls: string[]): Record<string, Mark> {
  const key = urls.join(' '); // a link holds no space: the list as one dependency, stable across state broadcasts
  const [read, setRead] = useState<{ key: string; marks: Record<string, Mark> }>({ key: '', marks: {} });
  useEffect(() => {
    let isCurrent = true; // a list that changed while its reads ran drops their answers
    for (const url of key === '' ? [] : key.split(' ')) {
      getJson<unknown>(prPath(url, '/checks')).then((answer) => {
        const mark = isChecksRead(answer) ? answer.checks?.state : undefined;
        if (isCurrent && mark !== undefined) setRead((current) => ({ key, marks: { ...(current.key === key ? current.marks : {}), [url]: mark } }));
      }, () => undefined);
    }
    return () => { isCurrent = false; };
  }, [key]);
  return read.key === key ? read.marks : {};
}

// k/n #N and the state; another repository's #N with its name and "outside the stack" before the state (handoff 7)
function lineText(line: PrLine, repo: string | undefined): string {
  const k = line.position === undefined ? '' : `${line.position.k}/${line.position.total} `;
  const number = `#${prNumber(line.pr.url)}`;
  const state = t(`detail.pr.${line.pr.state}`);
  return repo === undefined ? `${k}${number} ${state}` : [`${number} ${repoName(repo)}`, t('pr.stack.outside'), state].join(' · ');
}

function PrMark({ mark }: { mark?: Mark }) {
  if (mark === undefined) return null;
  const label = t(`issue.prs.checks.${mark}`);
  return (
    <>
      <span aria-hidden="true" title={label} className={MARKS[mark].tone}>{MARKS[mark].glyph}</span>
      <span className="sr-only">{label}</span>
    </>
  );
}

export interface TaskPrListProps { task: Task; state: State; except?: string; onOpenPr(url: string): void }

// The list's heading: PRs on the issue page (#65); on a PR's page (#66) "other PRs of the task" and how many, no heading element, since the
// panel's title is the slot's only heading there
function Heading({ count, isOthers }: { count: number; isOthers: boolean }) {
  if (!isOthers) return <h3 className={MUTED}>{t('detail.prs')}</h3>;
  return <p className="flex items-baseline gap-1.5"><span className="font-medium text-foreground">{t('pr.others')}</span><span className={MUTED}>{count}</span></p>;
}

/** The task's PRs under the page's block (#65, #66, handoff 7): grouped and ordered as the details grid and the flow card (#698), each with
 * its state, its checks mark and, while open, "open" through the dashboard's PR opener. On a PR's page `except` is that PR: it is left out
 * and its repository is the own one. Nothing with no PR to list. */
export function TaskPrList({ task, state, except, onOpenPr }: TaskPrListProps) {
  const groups = prGroups(prsOf(state, task.item.itemId), except === undefined ? task.item.facets?.repository : prRepo(except));
  const lines = groups.flatMap((group) => group.lines.filter((line) => line.pr.url !== except).map((line) => ({ line, repo: group.own ? undefined : group.repo })));
  const marks = usePrMarks(lines.filter(({ line }) => line.pr.state === 'open').map(({ line }) => line.pr.url));
  if (lines.length === 0) return null;
  return (
    <section aria-label={t(except === undefined ? 'detail.prs' : 'pr.others')} className="flex flex-col gap-1.5 text-xs">
      <Heading count={lines.length} isOthers={except !== undefined} />
      <ul className="flex flex-col gap-1">
        {lines.map(({ line, repo }) => (
          <li key={line.pr.url} className="flex items-center gap-1.5">
            <span className="min-w-0 truncate tabular-nums">{lineText(line, repo)}</span>
            <PrMark mark={marks[line.pr.url]} />
            {line.pr.state === 'open' && (
              <Button type="button" variant="link" size="xs" className="ml-auto h-auto p-0 text-review" onClick={() => onOpenPr(line.pr.url)}>{t('issue.prs.open')}</Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
