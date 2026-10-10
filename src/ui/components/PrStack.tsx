import { prsOf } from '../../activities';
import { type PrLine, prGroups, prNumber, prRepo, repoName } from '../../pull-requests';
import type { PrData, State, Task } from '../../types';
import { t } from '@/i18n';

// One part of the stack: k/n #N and its state, a button to its page; this PR in foreground, with no button
function Part({ line, isThis, onOpen }: { line: PrLine; isThis: boolean; onOpen(url: string): void }) {
  const k = line.position === undefined ? '' : `${line.position.k}/${line.position.total} `;
  const number = <span className="tabular-nums">{`${k}#${prNumber(line.pr.url)}`}</span>;
  if (isThis) return <span className="text-foreground">{number} <span>{t('pr.stack.this')}</span></span>;
  return <button type="button" className="hover:text-foreground" onClick={() => onOpen(line.pr.url)}>{number} {t(`detail.pr.${line.pr.state}`)}</button>;
}

export interface PrStackProps { pr: PrData; task: Task; state: State; onOpenPr(url: string): void }

/** stack (#758, handoff 03): the task's PRs in this PR's repository in merge order (#698), k/n and their state, this one in foreground; base #N
 * while this PR's base PR is open; a 1×14px divider, then the task's PRs in other repositories, the number in review blue. A part opens its
 * PR's page. Hidden while the task holds this PR alone. */
export function PrStack({ pr, task, state, onOpenPr }: PrStackProps) {
  const prs = prsOf(state, task.item.itemId);
  if (prs.length < 2) return null;
  const repo = prRepo(pr.url);
  const groups = prGroups(prs, repo);
  const own = groups.find((group) => group.repo === repo)?.lines ?? [];
  const others = groups.filter((group) => group.repo !== repo).flatMap((group) => group.lines.map((line) => ({ url: line.pr.url, repo: group.repo })));
  const base = own.find((line) => line.pr.url === pr.url)?.base;
  const isBaseOpen = base !== undefined && prs.some((p) => p.url === base && p.state === 'open');
  return (
    <section aria-label={t('pr.stack')} className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
      <span>{t('pr.stack')}</span>
      {own.map((line) => <Part key={line.pr.url} line={line} isThis={line.pr.url === pr.url} onOpen={onOpenPr} />)}
      {isBaseOpen && <span>{t('pr.stack.base', { n: prNumber(base) })}</span>}
      {others.length > 0 && <span aria-hidden="true" className="h-3.5 w-px bg-border" />}
      {others.length > 0 && <span>{t('pr.stack.outside')}</span>}
      {others.map((other) => (
        <button key={other.url} type="button" className="hover:text-foreground" onClick={() => onOpenPr(other.url)}>
          <span className="text-review">#{prNumber(other.url)}</span> {repoName(other.repo)}
        </button>
      ))}
    </section>
  );
}
