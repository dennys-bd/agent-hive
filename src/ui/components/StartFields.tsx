import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { KeyLike } from '../../shortcuts';
import type { BaseOptions, Task, Stage } from '../../types';
import { WorkspaceSelect } from '@/components/WorkspaceSelect';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type BaseChoice, stackedOn } from '@/hooks/use-start-base';
import { statusText, t } from '@/i18n';
import { pressed } from '@/lib/shortcut-bindings';
import { stagePath } from '@/lib/start-flow';

/** executar etapas follows the flow, one prompt per stage; sessão livre opens the agent with no automatic prompt (redesign 11). */
export type StartMode = 'stages' | 'free';

/** The mode the switchStartMode key (#585) leaves the dialog in: the other one, or undefined for any other key. While executar etapas is off
 * for the task (#774) the key does nothing on sessão livre, so it never reaches a mode the toggle refuses. */
export function modeAfterKey(event: KeyLike, mode: StartMode, stagesOff: boolean): StartMode | undefined {
  if (!pressed(event, 'switchStartMode')) return undefined;
  if (mode === 'stages') return 'free';
  return stagesOff ? undefined : 'stages';
}

const HINT = { stages: 'start.hint.stages', free: 'start.hint.free' } as const;
const MODE = { stages: 'start.mode.stages', free: 'start.mode.free' } as const;

interface ModeToggleProps { mode: StartMode; stagesOff?: string; onChange(mode: StartMode): void }

/** executar etapas or sessão livre and the chosen mode's hint. `stagesOff` (#774) is why executar etapas is off for the task: the item is
 * disabled and the reason takes the hint's place. */
export function ModeToggle({ mode, stagesOff, onChange }: ModeToggleProps) {
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => { if (v) onChange(v as StartMode); }} className="w-full">
        {(['stages', 'free'] as const).map((m) => (
          <ToggleGroupItem key={m} value={m} disabled={m === 'stages' && stagesOff !== undefined} className="flex-1 font-medium text-[13px]">{t(MODE[m])}</ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-muted-foreground text-xs">{stagesOff ?? t(HINT[mode])}</p>
    </div>
  );
}

interface BaseComboboxProps { options: BaseOptions; chosen: string; onChoose(ref: string): void }

/** The base combobox (#131): the default, the tasks, the local and (once searched) the remote branches. cmdk owns the keyboard and hover
 * highlight; the choice only changes through `onSelect` (a click or Enter), which also closes the popover and clears the search. */
function BaseCombobox({ options, chosen, onChoose }: BaseComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const select = (ref: string): void => { onChoose(ref); setSearch(''); setOpen(false); };
  const item = (ref: string, label = ref, keywords?: string[]) => (
    <CommandItem key={ref} value={ref} keywords={keywords} onSelect={select}>
      <CheckIcon className={ref === chosen ? 'opacity-100' : 'opacity-0'} />
      {label}
    </CommandItem>
  );
  // a chosen remote branch stays listed (with its check) after the search that surfaced it is cleared
  const remote = search !== '' ? options.remote : options.remote.filter((ref) => ref === chosen);
  const chosenTask = options.tasks.find((c) => c.ref === chosen);
  const triggerLabel = chosenTask ? `#${chosenTask.id} ${chosenTask.title}` : chosen;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={triggerLabel} title={triggerLabel} className="w-full min-w-0 justify-between">
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command label={t('start.base')}>
          <CommandInput value={search} onValueChange={setSearch} aria-label={t('start.base')} />
          <CommandList>
            <CommandGroup heading={t('base.group.default')}>{item(options.defaultRef)}</CommandGroup>
            {options.tasks.length > 0 && (
              <CommandGroup heading={t('base.group.tasks')}>{options.tasks.map((c) => item(c.ref, `#${c.id} ${c.title}`, [c.id, c.title]))}</CommandGroup>
            )}
            {options.local.length > 0 && <CommandGroup heading={t('base.group.local')}>{options.local.map((ref) => item(ref))}</CommandGroup>}
            {remote.length > 0 && <CommandGroup heading={t('base.group.remote')}>{remote.map((ref) => item(ref))}</CommandGroup>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function SwitchRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange(checked: boolean): void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  );
}

// #267: the classes worth a word; `own` is today's reuse
const RELATION = { unrelated: 'start.orphan.unrelated', stale: 'start.orphan.stale' } as const;
const ACTION = { unrelated: 'start.orphan.setAside', stale: 'start.orphan.recreate' } as const;
const flagged = (orphan: NonNullable<BaseOptions['orphan']>): keyof typeof RELATION | undefined =>
  (orphan.relation === 'unrelated' || orphan.relation === 'stale' ? orphan.relation : undefined);

// #861: git holds a worktree or a branch for this task and no activity owns it: Reuse adopts it (the default), Discard removes it and the task
// starts from the base below. Only executar etapas can discard: a free session's open adopts what it finds, and on a branch alone
// ensureWorktree acts on its class (#267), which the line says.
function OrphanChoice({ mode, choice, onChange }: { mode: StartMode; choice: BaseChoice; onChange(choice: BaseChoice): void }) {
  const orphan = choice.lists?.orphan;
  if (orphan === undefined) return null;
  const relation = flagged(orphan);
  // a free open on the branch alone goes through ensureWorktree, which acts on the class; a worktree on disk is adopted as it is
  const acts = mode === 'free' && !orphan.worktree;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t(orphan.worktree ? 'start.orphan.worktree' : 'start.orphan.branch')}</p>
      {relation && <p className="text-muted-foreground text-xs">{t(RELATION[relation])}</p>}
      {relation && acts && <p className="text-muted-foreground text-xs">{t(ACTION[relation], { name: `${orphan.branchName ?? ''}-old-…` })}</p>}
      {mode === 'stages' && (
        <ToggleGroup type="single" variant="outline" value={choice.discard ? 'discard' : 'reuse'} onValueChange={(v) => { if (v) onChange({ ...choice, discard: v === 'discard' }); }} className="w-full">
          <ToggleGroupItem value="reuse" className="flex-1 text-[13px]">{t('start.orphan.reuse')}</ToggleGroupItem>
          <ToggleGroupItem value="discard" className="flex-1 text-[13px]">{t('start.orphan.discard')}</ToggleGroupItem>
        </ToggleGroup>
      )}
    </div>
  );
}

interface BaseFieldProps { id: string; mode: StartMode; choice: BaseChoice; workspaces: string[]; onChange(choice: BaseChoice): void; onWorkspace(workspace?: string): void }

/** base, the stacked-PR switch and executar no local: only while the task has no worktree yet; a task no rule places asks for its workspace
 * first (#179). The stacked-PR switch shows on a task base in executar etapas alone, since only a stage prompt carries it (#217). An orphan
 * (#861) shows its notice and choice first, and the base only once it is discarded. */
export function BaseField({ id, mode, choice, workspaces, onChange, onWorkspace }: BaseFieldProps) {
  const { lists } = choice;
  if (lists === undefined || lists.hasWorktree) return null;
  if (lists.needsWorkspace) return <WorkspaceSelect id={`${id}-project`} label={t('task.workspace')} workspaces={workspaces} value={choice.workspace} onChange={onWorkspace} />;
  const discarding = mode === 'stages' && choice.discard; // #267: a preselected discard is executar etapas' alone; sessão livre reuses
  const orphan = <OrphanChoice mode={mode} choice={choice} onChange={onChange} />;
  if (lists.orphan !== undefined && !discarding) return orphan; // reuse adopts what git holds: no base to choose
  const stacked = mode === 'stages' ? stackedOn(choice) : undefined;
  return (
    <div className="flex flex-col gap-2">
      {orphan}
      <Label>{t('start.base')}</Label>
      <BaseCombobox options={lists} chosen={choice.chosen} onChoose={(chosen) => onChange({ ...choice, chosen })} />
      {stacked && <SwitchRow id={`${id}-stacked`} label={t('start.stacked', { id: stacked.id })} checked={choice.tellWorker} onChange={(tellWorker) => onChange({ ...choice, tellWorker })} />}
      <SwitchRow id={`${id}-local`} label={t('start.local')} checked={choice.local} onChange={(local) => onChange({ ...choice, local })} />
    </div>
  );
}

// One line of the stages box: its label in the 72px column
function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </>
  );
}

/** What executar etapas will do: the run (#290), the stages ahead, and where the task stops for the user. */
export function StagesBox({ task, stages, run }: { task?: Task; stages: Stage[]; run: ReactNode }) {
  const path = task === undefined ? undefined : stagePath(task.stage, stages);
  const stop = path?.stop === undefined ? '—' : path.approval ? `${path.stop} · ${statusText('approval')}` : path.stop;
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 rounded-md border p-2.5 text-xs">
      {run}
      <Row label={t('start.next')} value={path && path.next.length > 0 ? path.next.join(' → ') : '—'} />
      <Row label={t('start.stopsAt')} value={stop} />
    </div>
  );
}
