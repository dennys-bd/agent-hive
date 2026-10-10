import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DeleteDoneDialog } from '@/components/DeleteDoneDialog';
import type { TaskActivity } from '@/lib/activities';
import type { ActivityGroup } from '@/lib/activity-groups';

interface GroupHeaderProps { group: ActivityGroup; isOpen: boolean; onToggle(): void }

// A group's header (#586): chevron, its name in foreground, its count, a 1px rule to the edge, and done's excluir todas… on the right
function GroupHeader({ group, isOpen, onToggle }: GroupHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 py-[3px] pr-2 pl-2.5 text-muted-foreground text-xs">
      <button type="button" aria-expanded={isOpen} onClick={onToggle} className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left">
        <ChevronDownIcon className={`size-3 shrink-0 ${isOpen ? '' : '-rotate-90'}`} />
        <span className="truncate text-foreground">{group.name}</span>
        <span className="shrink-0">{group.items.length}</span>
      </button>
      <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-border" />
      {group.isDone && <DeleteDoneDialog activities={group.items} />}
    </div>
  );
}

interface GroupListProps { groups: ActivityGroup[]; isFlat: boolean; collapsed: string[]; onToggle(key: string): void; entry(activity: TaskActivity): ReactNode }

/** A workspace's activities in their groups (#586), each collapsing on its chevron. Sem agrupamento's one list has no header; done keeps its
 * own in every mode. */
export function ActivityGroupList({ groups, isFlat, collapsed, onToggle, entry }: GroupListProps) {
  return groups.map((group) => {
    if (isFlat && !group.isDone) return <div key={group.key} className="flex flex-col gap-0.5">{group.items.map(entry)}</div>;
    const isOpen = !collapsed.includes(group.key);
    return (
      // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names its header and rows
      <div key={group.key} role="group" aria-label={group.name} className="flex flex-col gap-0.5 pt-1">
        <GroupHeader group={group} isOpen={isOpen} onToggle={() => onToggle(group.key)} />
        {isOpen && group.items.map(entry)}
      </div>
    );
  });
}
