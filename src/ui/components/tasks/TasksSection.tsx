import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import type { SidebarSection } from '@/lib/tasks-sidebar';

export interface TasksSectionProps { id: SidebarSection; title: string; action?: ReactNode; isOpen: boolean; height?: number; onToggle(): void; children: ReactNode }

/** One section of the tasks sidebar (#572, handoff §4): a 26px title that toggles it, its action beside it (a button of its own, never the
 * toggle), and its content scrolling inside it with the bar hidden. Open with a height, it keeps it; open without one, it takes what is left;
 * closed, only the title. A closed body stays mounted, hidden: the sources' ⌥n keys and the repositories' read keep running. */
export function TasksSection({ id, title, action, isOpen, height, onToggle, children }: TasksSectionProps) {
  const size = !isOpen ? 'flex-none' : height === undefined ? 'min-h-0 flex-[1_1_0]' : 'min-h-0 flex-none';
  return (
    <div data-section={id} className={`flex flex-col ${size}`} style={isOpen && height !== undefined ? { height } : undefined}>
      <div className="flex h-[26px] flex-none items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
        <button type="button" aria-expanded={isOpen} aria-label={t('tasks.sidebar.toggle', { name: title })} onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-1 text-left">
          {isOpen ? <ChevronDownIcon aria-hidden="true" className="size-3.5" /> : <ChevronRightIcon aria-hidden="true" className="size-3.5" />}
          <span className="truncate">{title}</span>
        </button>
        {action}
      </div>
      <div hidden={!isOpen} className="scrollbar-none min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** A section's + (handoff §4b, §4c). */
export function SectionAdd({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Button type="button" size="icon-xs" variant="ghost" className="size-5 text-muted-foreground" aria-label={label} onClick={onClick}>
      <PlusIcon />
    </Button>
  );
}

/** Decision 4: the 7px handle between two open sections, a 1px border line on hover. */
export function ResizeHandle({ name, onMouseDown }: { name: string; onMouseDown(event: ReactMouseEvent): void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take a drag; a separator between sections is the splitter pattern, as ColumnDividers'
    <span role="separator" aria-orientation="horizontal" aria-label={t('tasks.sidebar.resize', { name })} onMouseDown={onMouseDown} className="group flex h-[7px] flex-none cursor-row-resize select-none items-center">
      <span className="h-px w-full group-hover:bg-border" />
    </span>
  );
}
