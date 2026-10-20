import { ChevronDownIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { HIVE_SOURCE, taskLabel, resolveWorkspace } from '../../tasks';
import type { Task } from '../../types';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { t } from '@/i18n';
import type { Destination } from '@/lib/create-targets';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

export interface TaskPickerProps {
  id: string; tasks: Task[]; workspaces: string[]; sourceWorkspaces?: Record<string, string>;
  value?: string; // the picked task's itemId
  destinations?: Destination[]; // where a typed term may be created, the default first; absent: the hive alone
  heldLabel?: string; // a task held for creation (#846): shown in the closed field while nothing is picked
  onPick(itemId: string): void; onCreate(title: string, destination: string): void;
}

const CREATE = '+create'; // cmdk's value for the create row: an itemId is local:<n> or <source>:<id>, never this
const PICK = '+in'; // cmdk's value prefix for a row of criar em (#893), which no itemId starts with either
const HIVE_ALONE: Destination[] = [{ name: HIVE_SOURCE }];
const CHIP = 'shrink-0 rounded-[4px] border px-1.5 text-xs';

// criar em's second line (#893): hive creates no external issue; a source names its type
const hintOf = (d: Destination): string => (d.type === undefined ? t('start.createInHive') : t(`flow.source.type.${d.type}`));

// A task as a row: its workspace's colour, its title, its stage on the right
function TaskRow({ task, workspaces, sourceWorkspaces }: { task: Task; workspaces: string[]; sourceWorkspaces?: Record<string, string> }) {
  const workspace = resolveWorkspace(task, workspaces, sourceWorkspaces);
  return (
    <>
      <WorkspaceSquare name={workspace} />
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

// The closed field (#893): the pick or the held entry with its chevron; with neither it reads as a search box, the ⌕ and its placeholder
function ClosedField({ id, label, onOpen }: { id: string; label?: string; onOpen(): void }) {
  const isEmpty = label === undefined;
  return (
    <Button id={id} type="button" variant="outline" aria-haspopup="listbox" aria-expanded={false} title={label} onClick={onOpen} className="w-full min-w-0 justify-start font-normal">
      <SearchIcon className="opacity-50" />
      <span className={`min-w-0 flex-1 truncate text-left ${isEmpty ? 'text-muted-foreground' : ''}`}>{label ?? t('start.taskPlaceholder')}</span>
      {!isEmpty && <ChevronDownIcon className="opacity-50" />}
    </Button>
  );
}

function TaskList({ tasks, workspaces, sourceWorkspaces, onSelect }: Pick<TaskPickerProps, 'tasks' | 'workspaces' | 'sourceWorkspaces'> & { onSelect(value: string): void }) {
  return (
    <>
      <CommandEmpty>{t('start.noTask')}</CommandEmpty>
      <CommandGroup>
        {tasks.map((task) => (
          <CommandItem key={task.item.itemId} value={task.item.itemId} keywords={[taskLabel(task), task.stage]} onSelect={onSelect}>
            <TaskRow task={task} workspaces={workspaces} sourceWorkspaces={sourceWorkspaces} />
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

// The create row's destination (#893): a chip that opens criar em, plain with hive alone, which leaves nothing to choose. The row's own
// click and Enter create, so the chip stops both; the mouse keeps the focus in the search box
function DestinationChip({ name, canChoose, onChoose }: { name: string; canChoose: boolean; onChoose(): void }) {
  const label = t('start.createIn', { source: name });
  if (!canChoose) return <span className={CHIP}>{label}</span>;
  const onClick = (e: ReactMouseEvent): void => { e.stopPropagation(); onChoose(); };
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Enter') return; // cmdk's own Enter, one level up, would create
    e.preventDefault(); e.stopPropagation(); onChoose();
  };
  return (
    <button type="button" aria-haspopup="listbox" onMouseDown={(e) => e.preventDefault()} onClick={onClick} onKeyDown={onKeyDown} className={`${CHIP} inline-flex items-center gap-1 hover:text-foreground`}>
      {label}<ChevronDownIcon className="size-3" />
    </button>
  );
}

// + criar tarefa "{term}" (#846, #893): one row, created in the chip's destination
function CreateRow({ term, target, canChoose, onChoose, onSelect }: { term: string; target: Destination; canChoose: boolean; onChoose(): void; onSelect(value: string): void }) {
  return (
    <>
      <CommandSeparator alwaysRender />
      <CommandGroup forceMount>
        <CommandItem value={CREATE} forceMount onSelect={onSelect}>
          <PlusIcon />
          <span className="min-w-0 flex-1 truncate">{t('start.create', { title: term })}</span>
          <DestinationChip name={target.name} canChoose={canChoose} onChoose={onChoose} />
        </CommandItem>
      </CommandGroup>
    </>
  );
}

// criar em (#893): every destination with its second line. It lives in the list, under the row: a floating menu would be cut by the list's
// scroll, and a portalled one would take the focus out of the field, whose blur closes it
function DestinationMenu({ destinations, onSelect }: { destinations: Destination[]; onSelect(value: string): void }) {
  return (
    <CommandGroup forceMount heading={t('start.createInMenu')}>
      {destinations.map((d) => (
        <CommandItem key={d.name} value={`${PICK}:${d.name}`} forceMount onSelect={onSelect}>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{d.name}</span>
            <span className="truncate text-muted-foreground text-xs">{hintOf(d)}</span>
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** The Start dialog's task field (redesign 11, 2c, #893): a field that holds the dialog's first focus and reads as a search box until
 * something is picked; a click or Enter opens the search with the focus in it and its list under it; while something is typed, one
 * + criar tarefa "{term}" row whose chip names the destination and opens criar em to change it (#846). The list lives in the dialog, not in a
 * portal, so it stays inside the dialog's focus trap. Escape closes criar em, then the list; a focus leaving the field closes both. */
export function TaskPicker({ id, tasks, workspaces, sourceWorkspaces, value, destinations = HIVE_ALONE, heldLabel, onPick, onCreate }: TaskPickerProps) {
  const [isOpen, setIsOpen] = useState(false); // opened by the user: a list open on arrival reads as something already happening
  const [search, setSearch] = useState('');
  const [isChoosing, setIsChoosing] = useState(false); // criar em is open
  const [destination, setDestination] = useState<string>(); // the chip's pick; undefined: the default
  const [highlight, setHighlight] = useState(''); // cmdk's highlighted row, held so criar em opens on the chip's destination
  const picked = tasks.find((c) => c.item.itemId === value);
  const target = destinations.find((d) => d.name === destination) ?? destinations[0];
  const root = useRef<HTMLDivElement>(null);
  // cmdk gives its input an id of its own, so the field's id no longer finds it while the list is open
  const focusSearch = (): void => root.current?.querySelector<HTMLInputElement>('[cmdk-input]')?.focus();
  const close = (): void => { setIsOpen(false); setIsChoosing(false); };
  useListKeys(id, isOpen, () => { if (isChoosing) setIsChoosing(false); else close(); });
  const openMenu = (): void => { setIsChoosing(true); setHighlight(`${PICK}:${target.name}`); focusSearch(); };
  const choose = (chosen: string): void => {
    if (chosen.startsWith(`${PICK}:`)) { setDestination(chosen.slice(PICK.length + 1)); setIsChoosing(false); setHighlight(CREATE); focusSearch(); return; }
    close();
    setSearch('');
    if (chosen === CREATE) onCreate(search.trim(), target.name);
    else onPick(chosen);
  };
  if (!isOpen) return <ClosedField id={id} label={picked ? taskLabel(picked) : heldLabel} onOpen={() => { setHighlight(''); setIsOpen(true); }} />;
  const term = search.trim();
  return (
    <Command
      ref={root} label={t('start.task')} loop value={highlight} onValueChange={setHighlight} className={`relative ${FIELD}`}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}
    >
      <CommandInput id={id} value={search} onValueChange={(next) => { setSearch(next); setIsChoosing(false); }} aria-label={t('start.search')} placeholder={t('start.search')} autoFocus />
      <CommandList className="absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover shadow-md">
        {!isChoosing && <TaskList tasks={tasks} workspaces={workspaces} sourceWorkspaces={sourceWorkspaces} onSelect={choose} />}
        {term !== '' && <CreateRow term={term} target={target} canChoose={destinations.length > 1} onChoose={openMenu} onSelect={choose} />}
        {isChoosing && <DestinationMenu destinations={destinations} onSelect={choose} />}
      </CommandList>
    </Command>
  );
}
