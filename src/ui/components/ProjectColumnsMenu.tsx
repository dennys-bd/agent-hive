import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { columnLabel, type ProjectColumn } from '@/lib/project-columns';

/** A subbar menu's button (handoff 01b): styled as atualizar, its label, the current value in muted and ⌄; open, a foreground border. */
export function SubbarMenuTrigger({ label, value }: { label: string; value: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="outline" size="xs" className="data-[state=open]:border-foreground">
        {label}<span className="text-muted-foreground">{value}</span><ChevronDownIcon aria-hidden="true" className="size-3 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
  );
}

// The handoff's 14px checkbox: radius 3, a foreground fill and ✓ when checked
function Box({ checked }: { checked: boolean }) {
  const fill = checked ? 'border-foreground bg-foreground text-background' : '';
  return (
    <span aria-hidden="true" className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border ${fill}`}>
      {checked && <CheckIcon className="size-3" />}
    </span>
  );
}

interface ProjectColumnsMenuProps { columns: ProjectColumn[]; visible: string[]; onChange(visible: string[]): void }

/** The columns menu (#756, handoff 01b): every hideable column in its order, each with where it comes from; issue and the action are not
 * listed. A toggle keeps the menu open, so several columns change in one visit. */
export function ProjectColumnsMenu({ columns, visible, onChange }: ProjectColumnsMenuProps) {
  const shown = columns.filter((c) => visible.includes(c.key));
  const toggle = (key: string): void =>
    onChange(columns.filter((c) => (c.key === key ? !visible.includes(key) : visible.includes(c.key))).map((c) => c.key));
  return (
    <DropdownMenu>
      <SubbarMenuTrigger label={t('project.columns')} value={`${shown.length}/${columns.length}`} />
      <DropdownMenuContent align="end" className="w-[240px]">
        {columns.map((c) => (
          <DropdownMenuItem
            key={c.key} role="menuitemcheckbox" aria-checked={visible.includes(c.key)}
            onSelect={(e) => { e.preventDefault(); toggle(c.key); }}
          >
            <Box checked={visible.includes(c.key)} />
            <span className="flex-1 truncate">{columnLabel(c)}</span>
            <span className="text-muted-foreground text-xs">{t(c.key === 'pr' ? 'project.columns.origin.hive' : 'project.columns.origin.project')}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-muted-foreground text-xs">{t('project.columns.note')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
