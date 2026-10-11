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

/** A group's header (handoff 01b, #60): ⌄ or ›, its name, its count in a pill and, grouped by status, its stage. Sticky under the 34px table
 * header on its own card fill, so the next group's header covers it as it reaches the top. A click folds or unfolds it. */
export function ProjectGroupRow({ group, isCollapsed, onToggle }: { group: ProjectGroup; isCollapsed: boolean; onToggle(): void }) {
  const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    // opaque and above the dividers' overlay, so a divider stops at it (#59); under the table header's z-10
    <tr className="sticky top-[34px] z-[5] flex h-9 items-center border-y bg-card px-3 text-muted-foreground text-xs">
      <td className="min-w-0 flex-1">
        <button type="button" aria-expanded={!isCollapsed} onClick={onToggle} className="flex w-full min-w-0 items-center gap-1.5">
          <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />
          <span className="truncate font-semibold text-[13px] text-foreground">{group.label}</span>
          <span className="shrink-0 rounded-[9px] bg-muted px-1.5 tabular-nums">{group.items.length}</span>
          {group.stage !== undefined && <span className="truncate">{group.stage}</span>}
        </button>
      </td>
    </tr>
  );
}
