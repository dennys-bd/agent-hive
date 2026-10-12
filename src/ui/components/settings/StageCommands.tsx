import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { t } from '@/i18n';
import type { StageDraft } from '@/lib/settings-stages';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { resolveCommand } from '../../../run-commands';
import type { Command, OnMissing } from '../../../types';

// A commands stage's executa block (#755, handoff 6b and "commands per workspace"). The stage holds names only: each row shows, for every
// workspace of the Comb, the line workspaces › comandos resolves there, or that it is missing there and what onMissing does then. No workspace
// chips here: where a command exists is the commands table's call.

interface StageCommandsProps { id: string; stage: StageDraft; options: readonly Command[]; workspaces: readonly string[]; onUpdate(patch: Partial<StageDraft>): void }

// The list with the name at `from` moved to `to`: a new array
function moved(list: readonly string[], from: number, to: number): string[] {
  const rest = list.filter((_, i) => i !== from);
  return [...rest.slice(0, to), list[from], ...rest.slice(to)];
}

interface RowProps {
  name: string; index: number; option?: Command; workspaces: readonly string[]; onMissing: OnMissing;
  onRemove(): void; onDragStart(): void; onDrop(): void; onMove(by: -1 | 1): void;
}

// Alt+↑ / Alt+↓ on a focused row: the keyboard's way to the order a drag sets
const MOVE_KEYS: Record<string, -1 | 1> = { ArrowUp: -1, ArrowDown: 1 };

// Where the command runs: every workspace on a wrapping line, its square then its line there; one with no line reads missing · falha in
// destructive under fail and missing · pula muted under skip. A name the Comb lost fails whatever onMissing says, as the run does
function WorkspaceLines({ option, workspaces, onMissing }: Pick<RowProps, 'option' | 'workspaces' | 'onMissing'>) {
  const fails = onMissing === 'fail' || option === undefined;
  return (
    <span className="flex flex-wrap gap-x-3 font-mono text-xs">
      {workspaces.map((workspace) => {
        const line = option && resolveCommand(option, workspace);
        const text = line ?? t(fails ? 'settings.stages.commands.missingFails' : 'settings.stages.commands.missingSkips', { workspace });
        return (
          <span key={workspace} className="flex min-w-0 items-center gap-1.5">
            <WorkspaceSquare name={workspace} />
            <span className={`truncate ${line === undefined && fails ? 'text-destructive' : 'text-muted-foreground'}`}>{text}</span>
          </span>
        );
      })}
    </span>
  );
}

// One row: its place, its name over where it runs, and x. The row is what drags, and what Alt+↑ / ↓ moves
function CommandRow({ name, index, option, workspaces, onMissing, onRemove, onDragStart, onDrop, onMove }: RowProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>): void => {
    const by = MOVE_KEYS[event.key];
    if (!event.altKey || by === undefined || event.target !== event.currentTarget) return;
    event.preventDefault();
    onMove(by);
  };
  return (
    <li
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the row itself is what Alt+↑ / ↓ moves, the keyboard's equivalent of its drag
      tabIndex={0}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={onKeyDown}
      draggable onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}
      className="grid cursor-grab grid-cols-[1.25rem_minmax(0,1fr)_2rem] items-center gap-2 border-b py-1.5 pr-1.5 pl-3"
    >
      <span className="text-muted-foreground text-xs">{index + 1}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{name}</span>
        <WorkspaceLines option={option} workspaces={workspaces} onMissing={onMissing} />
      </span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.stages.commands.remove', { name })} onClick={onRemove}><XIcon /></Button>
    </li>
  );
}

// + comando at the box's foot: every Comb command not in the list yet, stages-only ones included
function AddCommand({ offer, onAdd }: { offer: readonly Command[]; onAdd(name: string): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="m-1 text-muted-foreground">{t('settings.stages.commands.add')}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {offer.map((o) => <DropdownMenuItem key={o.name} onSelect={() => onAdd(o.name)}>{o.name}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// se o workspace não tiver um comando: fail, the default, or skip, with the hint of the option picked
function OnMissingSelect({ id, value, onUpdate }: { id: string; value: OnMissing; onUpdate(patch: Partial<StageDraft>): void }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      <Label htmlFor={`${id}-onMissing`}>{t('settings.stages.commands.onMissing')}</Label>
      <Select value={value} onValueChange={(picked) => onUpdate({ onMissing: picked === 'skip' ? 'skip' : 'fail' })}>
        <SelectTrigger id={`${id}-onMissing`} className="w-full"><SelectValue>{t(`settings.stages.commands.onMissing.${value}`)}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="fail">{t('settings.stages.commands.onMissing.fail')}</SelectItem>
          <SelectItem value="skip">{t('settings.stages.commands.onMissing.skip')}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">{t(`settings.stages.commands.onMissing.${value}.hint`)}</p>
    </div>
  );
}

/** The commands block (#755): on the left the list in a bordered box, + comando at its foot, and its note; on the right the stop-at-the-first-
 * failure switch and its hint, what a missing line does, and the verdict note. Rows reorder by native drag and drop; the order is the run order. */
export function StageCommands({ id, stage, options, workspaces, onUpdate }: StageCommandsProps) {
  const [dragged, setDragged] = useState<number>();
  const list = stage.commands;
  const offer = options.filter((o) => !list.includes(o.name));
  const drop = (to: number): void => {
    if (dragged !== undefined && dragged !== to) onUpdate({ commands: moved(list, dragged, to) });
    setDragged(undefined);
  };
  return (
    <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-1">
        <span id={`${id}-commands`} className="font-medium text-sm leading-none">{t('settings.stages.commands')}</span>
        <div className="rounded-md border">
          <ul aria-labelledby={`${id}-commands`}>
            {list.map((name, i) => (
              <CommandRow
                key={name} name={name} index={i} option={options.find((o) => o.name === name)} workspaces={workspaces} onMissing={stage.onMissing}
                onRemove={() => onUpdate({ commands: list.filter((n) => n !== name) })} onDragStart={() => setDragged(i)} onDrop={() => drop(i)}
                onMove={(by) => { if (list[i + by] !== undefined) onUpdate({ commands: moved(list, i, i + by) }); }}
              />
            ))}
          </ul>
          {offer.length > 0 && <AddCommand offer={offer} onAdd={(name) => onUpdate({ commands: [...list, name] })} />}
        </div>
        <p className="text-muted-foreground text-xs">{t('settings.stages.commands.hint')}</p>
      </div>
      <div className="flex flex-col gap-1 md:pt-[22px]">
        <div className="flex items-center gap-2">
          <Switch id={`${id}-stopOnFailure`} checked={stage.stopOnFailure} onCheckedChange={(stopOnFailure) => onUpdate({ stopOnFailure })} />
          <Label htmlFor={`${id}-stopOnFailure`}>{t('settings.stages.commands.stopOnFailure')}</Label>
        </div>
        <p className="text-muted-foreground text-xs">{t('settings.stages.commands.stopOnFailure.hint')}</p>
        <OnMissingSelect id={id} value={stage.onMissing} onUpdate={onUpdate} />
        <p className="mt-2 text-muted-foreground text-xs">{t('settings.stages.commands.note')}</p>
      </div>
    </div>
  );
}
