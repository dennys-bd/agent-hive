import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ProjectItem, ProjectView } from '../../types';
import { act } from '@/components/actions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';

interface ProjectStatusSelectProps { source: string; itemId: string; status?: string; statuses: ProjectView['statuses']; onRow(row: ProjectItem): void }

/** The Status cell (#756, handoff 01): every option of the project's Status with the stage it enters, or — when no stage's from cites it.
 * Any option is written to the source, cited or not: the Status is GitHub's. A refusal is act's toast; the answer's re-read row replaces the
 * row (#686). */
export function ProjectStatusSelect({ source, itemId, status, statuses, onRow }: ProjectStatusSelectProps) {
  const choose = (name: string): void => {
    if (name === status) return;
    void act<{ row?: ProjectItem }>(`/sources/${encodeURIComponent(source)}/project/status`, { itemId, status: name }).then((answer) => {
      if (answer?.row !== undefined) onRow(answer.row);
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex max-w-full items-center gap-1 rounded-[5px] border px-2 py-0.5 text-xs">
          <span className="truncate">{status ?? '—'}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        <DropdownMenuLabel className="flex justify-between font-normal text-muted-foreground text-xs">
          <span>{t('project.status.head')}</span><span>{t('project.status.stage')}</span>
        </DropdownMenuLabel>
        {statuses.map((s) => (
          <DropdownMenuItem key={s.name} onSelect={() => choose(s.name)} className={s.name === status ? 'bg-muted' : undefined}>
            <CheckIcon aria-hidden="true" className={`size-3.5 ${s.name === status ? '' : 'invisible'}`} />
            <span className="flex-1 truncate">{s.name}</span>
            <span className="text-muted-foreground text-xs">{s.stage ?? '—'}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-muted-foreground text-xs">{t('project.status.note')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
