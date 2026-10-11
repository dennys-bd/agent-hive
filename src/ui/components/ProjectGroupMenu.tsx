import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { SubbarMenuTrigger } from '@/components/ProjectColumnsMenu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import type { GroupOption, ProjectGroup } from '@/lib/project-groups';

interface ProjectGroupMenuProps { options: GroupOption[]; groupBy: string | null; onChange(groupBy: string | null): void }

/** The group menu (#756, handoff 01b): nenhum, then what the view can group by; the current one with ✓ on muted, as the status menu. */
export function ProjectGroupMenu({ options, groupBy, onChange }: ProjectGroupMenuProps) {
  const choices: { key: string | null; label: string }[] = [{ key: null, label: t('project.group.none') }, ...options];
  const current = choices.find((c) => c.key === groupBy) ?? choices[0];
  return (
    <DropdownMenu>
      <SubbarMenuTrigger label={t('project.group')} value={current.label} />
      <DropdownMenuContent align="end" className="w-[220px]">
        {choices.map((c) => (
          <DropdownMenuItem
            key={c.key ?? ''} role="menuitemradio" aria-checked={c === current} onSelect={() => onChange(c.key)}
            className={c === current ? 'bg-muted' : undefined}
          >
            <CheckIcon aria-hidden="true" className={`size-3.5 ${c === current ? '' : 'invisible'}`} />
            <span className="flex-1 truncate">{c.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-muted-foreground text-xs">{t('project.group.note')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A group's row (handoff 01b): ⌄ or ›, its name, its count and, grouped by status, its stage. A click folds or unfolds it. */
export function ProjectGroupRow({ group, isCollapsed, onToggle }: { group: ProjectGroup; isCollapsed: boolean; onToggle(): void }) {
  const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    // opaque and stacked above the dividers' overlay, so a divider stops at it (#59); the header's full look is 3.2's
    <tr className="relative z-[1] flex h-8 items-center border-b bg-background px-3 text-muted-foreground text-xs">
      <td className="min-w-0 flex-1">
        <button type="button" aria-expanded={!isCollapsed} onClick={onToggle} className="flex w-full min-w-0 items-center gap-1.5">
          <Chevron aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{group.label}</span>
          <span className="tabular-nums">{group.items.length}</span>
          {group.stage !== undefined && <span className="truncate">{group.stage}</span>}
        </button>
      </td>
    </tr>
  );
}
