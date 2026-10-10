import { ChevronDownIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HIVE_SOURCE, taskLabel, resolveWorkspace } from '../../tasks';
import type { Task } from '../../types';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { t } from '@/i18n';
import { workspaceColor } from '@/lib/workspace-color';

export interface TaskPickerProps {
  id: string; tasks: Task[]; workspaces: string[]; sourceWorkspaces?: Record<string, string>;
  value?: string; // the picked task's itemId
  destinations?: string[]; // where a typed term may be created, the default first; absent: the hive alone
  heldLabel?: string; // a task held for creation (#846): shown in the closed field while nothing is picked
  onPick(itemId: string): void; onCreate(title: string, destination: string): void;
}

const CREATE = '+create'; // cmdk's value for the create row: an itemId is local:<n> or <source>:<id>, never this

// A task as a row: its workspace's colour, its title, its stage on the right
function TaskRow({ task, workspaces, sourceWorkspaces }: { task: Task; workspaces: string[]; sourceWorkspaces?: Record<string, string> }) {
  const workspace = resolveWorkspace(task, workspaces, sourceWorkspaces);
  return (
    <>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px] bg-muted" style={workspace === undefined ? undefined : { background: workspaceColor(workspace) }} />
      <span className="min-w-0 flex-1 truncate">{taskLabel(task)}</span>
      <span className="shrink-0 text-muted-foreground text-xs">{task.stage}</span>
    </>
  );
}

const FIELD = 'overflow-visible bg-transparent [&_[data-slot=command-input-wrapper]]:rounded-md [&_[data-slot=command-input-wrapper]]:border '
  + '[&_[data-slot=command-input-wrapper]]:border-ring [&_[data-slot=command-input-wrapper]]:ring-[3px] [&_[data-slot=command-input-wrapper]]:ring-ring/50';

// While the list is open Escape closes it alone: captured on the window, before the dialog's own capture on the document would close the
// dialog. Once it closes, the focus goes back to the field, whose search box just unmounted
function useListKeys(id: string, isOpen: boolean, close: () => void): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      if (wasOpen.current) document.getElementById(id)?.focus();
      wasOpen.current = false;
      return undefined;
    }
    wasOpen.current = true;
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [id, isOpen, close]);
}

/** The Start dialog's task field (redesign 11, 2c): a field that holds the dialog's first focus and opens, on a click or Enter, a search box
 * with the focus in it and its list under it; last, while something is typed, one + criar task "{term}" row per destination (#846), the
 * default first. The list lives in the
 * dialog, not in a portal, so it stays inside the dialog's focus trap. Escape and a focus leaving the field close the list. */
export function TaskPicker({ id, tasks, workspaces, sourceWorkspaces, value, destinations = [HIVE_SOURCE], heldLabel, onPick, onCreate }: TaskPickerProps) {
  const [isOpen, setIsOpen] = useState(false); // opened by the user: a list open on arrival reads as something already happening
  const [search, setSearch] = useState('');
  const picked = tasks.find((c) => c.item.itemId === value);
  useListKeys(id, isOpen, () => setIsOpen(false));
  const choose = (value: string): void => {
    setIsOpen(false);
    setSearch('');
    if (value.startsWith(`${CREATE}:`)) onCreate(search.trim(), value.slice(CREATE.length + 1));
    else onPick(value);
  };
  const label = picked ? taskLabel(picked) : heldLabel;
  if (!isOpen) {
    return (
      <Button id={id} type="button" variant="outline" aria-haspopup="listbox" aria-expanded={false} title={label} onClick={() => setIsOpen(true)} className="w-full min-w-0 justify-start font-normal">
        <SearchIcon className="opacity-50" />
        <span className={`min-w-0 flex-1 truncate text-left ${label === undefined ? 'text-muted-foreground' : ''}`}>{label ?? t('start.taskPlaceholder')}</span>
        <ChevronDownIcon className="opacity-50" />
      </Button>
    );
  }
  const close = (): void => setIsOpen(false);
  return (
    <Command
      label={t('start.task')} loop className={`relative ${FIELD}`}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}
    >
      <CommandInput id={id} value={search} onValueChange={setSearch} aria-label={t('start.search')} placeholder={t('start.search')} autoFocus />
      <CommandList className="absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover shadow-md">
        <CommandEmpty>{t('start.noTask')}</CommandEmpty>
        <CommandGroup>
          {tasks.map((task) => (
            <CommandItem key={task.item.itemId} value={task.item.itemId} keywords={[taskLabel(task), task.stage]} onSelect={choose}>
              <TaskRow task={task} workspaces={workspaces} sourceWorkspaces={sourceWorkspaces} />
            </CommandItem>
          ))}
        </CommandGroup>
        {search.trim() !== '' && (
          <>
            <CommandSeparator alwaysRender />
            <CommandGroup forceMount>
              {destinations.map((destination) => (
                <CommandItem key={destination} value={`${CREATE}:${destination}`} forceMount onSelect={choose}>
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate">{t('start.create', { title: search.trim() })}</span>
                  <span className="shrink-0 rounded-[4px] border px-1.5 text-xs">{t('start.createIn', { source: destination })}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
