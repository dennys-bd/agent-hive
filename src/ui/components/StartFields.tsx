import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useState } from 'react';
import { agentName, knownAgent } from '../../agents';
import type { KeyLike } from '../../shortcuts';
import { worktreeSessions } from '../../tasks';
import { AGENT_IDS, type AgentId, type BaseOptions, type Session, type Task, type Stage, type State } from '../../types';
import { WorkspaceSelect } from '@/components/WorkspaceSelect';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

interface BaseFieldProps { id: string; mode: StartMode; choice: BaseChoice; workspaces: string[]; onChange(choice: BaseChoice): void; onWorkspace(workspace?: string): void }

/** base, the stacked-PR switch and executar no local: only while the task has no worktree yet; a task no rule places asks for its workspace
 * first (#179). The stacked-PR switch shows on a task base in executar etapas alone, since only a stage prompt carries it (#217). */
export function BaseField({ id, mode, choice, workspaces, onChange, onWorkspace }: BaseFieldProps) {
  const { lists } = choice;
  if (lists === undefined || lists.hasWorktree) return null;
  if (lists.needsWorkspace) return <WorkspaceSelect id={`${id}-project`} label={t('task.workspace')} workspaces={workspaces} value={choice.workspace} onChange={onWorkspace} />;
  const stacked = mode === 'stages' ? stackedOn(choice) : undefined;
  return (
    <div className="flex flex-col gap-2">
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

/** What executar etapas will do: each stage's own agent, the stages ahead, and where the task stops for the user. */
export function StagesBox({ task, stages }: { task?: Task; stages: Stage[] }) {
  const path = task === undefined ? undefined : stagePath(task.stage, stages);
  const stop = path?.stop === undefined ? '—' : path.approval ? `${path.stop} · ${statusText('approval')}` : path.stop;
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 rounded-md border p-2.5 text-xs">
      <Row label={t('start.agent')} value={t('start.agentByStage')} />
      <Row label={t('start.next')} value={path && path.next.length > 0 ? path.next.join(' → ') : '—'} />
      <Row label={t('start.stopsAt')} value={stop} />
    </div>
  );
}

interface Choice { value: string; label: string }

export const NEW_SESSION = 'new'; // Radix Select rejects value=""; a session id is a uuid, never "new"
const SHORT_ID = 8;

const when = (iso: string): string => (iso === '' ? '—' : new Date(iso).toLocaleString());

// A row's stage part: a free session named first, before any stage a feedback run gave it (#812); — for a session with neither
const stageOfRow = (s: Session): string => [s.free ? t('detail.freeSession') : undefined, s.stages.at(-1)].filter((p) => p !== undefined).join(' · ') || '—';

// new, then every session the task may resume in its worktree (#164, #208; a repo one opens from the sidebar), newest first (#237)
function sessionChoices(task: Task, state: State): Choice[] {
  const sessions = [...worktreeSessions(task, state)].reverse();
  return [
    { value: NEW_SESSION, label: t('session.new') },
    ...sessions.map((s) => ({ value: s.id, label: t('session.row', { id: s.id.slice(0, SHORT_ID), stage: stageOfRow(s), time: when(s.startedAt) }) })),
  ];
}

function SelectField({ id, label, value, choices, onChange }: { id: string; label: string; value: string; choices: Choice[]; onChange(value: string): void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

interface FreeFieldsProps { id: string; task?: Task; state: State; session: string; agent: AgentId; onSession(session: string): void; onAgent(agent: AgentId): void }

/** sessão livre: the agent (every agent, the default preselected, #925) and the session, new or one to resume, side by side. */
export function FreeFields({ id, task, state, session, agent, onSession, onAgent }: FreeFieldsProps) {
  const sessions = task === undefined ? [] : sessionChoices(task, state);
  return (
    <div className="grid grid-cols-2 gap-3">
      <SelectField
        id={`${id}-agent`} label={t('start.agent')} value={agent} choices={AGENT_IDS.map((a) => ({ value: a, label: agentName(a) }))}
        onChange={(value) => { const picked = knownAgent(value); if (picked !== undefined) onAgent(picked); }}
      />
      <SelectField id={`${id}-session`} label={t('session.pick')} value={session} choices={sessions.length > 0 ? sessions : [{ value: session, label: t('session.new') }]} onChange={onSession} />
    </div>
  );
}
