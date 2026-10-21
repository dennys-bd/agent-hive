import { MoreHorizontalIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { repoName } from '../../pull-requests';
import type { RepoSummary } from '../../types';
import { Button } from '@/components/ui/button';
import { Syncing } from '@/components/ui/spinner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RECENT_SHOWN, recentCut, reloadRepositories, repoGroups, usePinned, useRepositories } from '@/hooks/use-repositories';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

const ROW = 'group flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent/50 data-[selected]:bg-muted';
const GROUP = 'px-2 py-0.5 text-[11px] text-muted-foreground';

interface RepoRowProps { repo: RepoSummary; isSelected: boolean; isPinned: boolean; onPick(repository: string): void; onPin(repository: string, isPinned: boolean): void }

// fixar / desafixar and abrir no github (handoff 02): shown on the picked row and on hover, always reachable by Tab
function RepoMenu({ repo, isPinned, onPin }: Pick<RepoRowProps, 'repo' | 'isPinned' | 'onPin'>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button" size="icon-xs" variant="ghost" aria-label={t('repos.menu', { name: repo.repository })}
          className="-my-1 size-5 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-data-[selected]:opacity-100"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuItem onSelect={() => onPin(repo.repository, !isPinned)}>{t(isPinned ? 'repos.menu.unpin' : 'repos.menu.pin')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.open(repo.url, '_blank', 'noreferrer')}>{t('repos.menu.open')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A repository's row (handoff 02): the workspace's square, the name, the open PRs, the ⋯; under it the workspace and the last activity. A
// fork's pair (#854) names each in full; the original says so, the fork hangs under it with ↳. A div, not a button: the ⋯ is a button of its
// own inside it, as on a source's row. A repository the model never synced (#182) shows the syncing mark in place of its open PRs.
function RepoRow({ repo, isSelected, isPinned, onPick, onPin }: RepoRowProps) {
  const isChild = repo.role === 'fork' || repo.role === 'nested'; // #653: a nested repo hangs as a fork does
  const when = repo.lastActivity === undefined ? [] : [relativeTime(repo.lastActivity)];
  const second = isChild ? [t(repo.role === 'fork' ? 'repos.fork' : 'repos.nested'), ...when] : [repo.workspace, ...(repo.role === 'original' ? [t('repos.original')] : []), ...when];
  return (
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      role="button" tabIndex={0} title={repo.repository} className={ROW} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected}
      onClick={(e) => { if (e.currentTarget.contains(e.target as Node) && !(e.target as Element).closest('button')) onPick(repo.repository); }}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(repo.repository); } }}
    >
      <span className="flex items-center gap-2">
        {isChild && <span aria-hidden="true" className="-mr-0.5 w-2.5 text-muted-foreground text-xs">↳</span>}
        <WorkspaceSquare name={repo.workspace} />
        <span className="min-w-0 flex-1 truncate">{repo.role === undefined ? repoName(repo.repository) : repo.repository}</span>
        <span className="w-6 text-right text-muted-foreground text-xs tabular-nums">{repo.syncedAt === null ? <Syncing /> : repo.openPrs}</span>
        <RepoMenu repo={repo} isPinned={isPinned} onPin={onPin} />
      </span>
      <span className={`${isChild ? 'pl-[34px]' : 'pl-4'} text-muted-foreground text-xs`}>{second.join(' · ')}</span>
    </div>
  );
}

/** The repositories of the flow sidebar (#757, handoff 02), below the sources: the pinned ones in pin order, then the rest by last activity,
 * RECENT_SHOWN of them and +N for the others. Read when it mounts; a pick here clears the source pick. Hidden while none is listed. */
export function FlowRepositories({ selected, onPick }: { selected?: string; onPick(repository: string): void }) {
  const repositories = useRepositories();
  const [pinned, pin] = usePinned();
  const [isExpanded, setIsExpanded] = useState(false);
  useEffect(() => { void reloadRepositories(); }, []);
  if (repositories.length === 0) return null;
  const groups = repoGroups(repositories, pinned);
  const cut = recentCut(groups.recent, RECENT_SHOWN); // #854, #653: a fork and the nested repos follow their repository, never cut from it
  const recent = isExpanded ? groups.recent : groups.recent.slice(0, cut);
  const hidden = groups.recent.length - recent.length;
  const row = (repo: RepoSummary) => (
    <RepoRow key={repo.repository} repo={repo} isSelected={selected === repo.repository} isPinned={pinned.includes(repo.repository)} onPick={onPick} onPin={pin} />
  );
  return (
    <section aria-label={t('repos.title')} className="flex min-h-0 flex-col gap-0.5">
      <div className="flex items-center justify-between pb-1.5 text-muted-foreground text-xs"><span>{t('repos.title')}</span><span>{t('repos.prs')}</span></div>
      {groups.pinned.length > 0 && <p className={GROUP}>{t('repos.pinned')}</p>}
      {groups.pinned.map(row)}
      {recent.length > 0 && <p className={`${GROUP} ${groups.pinned.length > 0 ? 'pt-2' : ''}`}>{t('repos.recent')}</p>}
      {recent.map(row)}
      {hidden > 0 && (
        <button type="button" className="px-2 py-1 text-left text-muted-foreground text-xs hover:text-foreground" onClick={() => setIsExpanded(true)}>
          {t('repos.more', { n: hidden })}
        </button>
      )}
    </section>
  );
}
