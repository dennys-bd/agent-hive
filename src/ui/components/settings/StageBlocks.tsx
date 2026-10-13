import { BotIcon, ListChecksIcon, type LucideIcon, Trash2Icon, UserCheckIcon, WorkflowIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentSelect } from '@/components/settings/AgentSelect';
import { MultiSelect } from '@/components/settings/MultiSelect';
import { StageCi } from '@/components/settings/StageCi';
import { StageCommands } from '@/components/settings/StageCommands';
import { StageVerdicts } from '@/components/settings/StageVerdicts';
import type { StageSource } from '@/components/settings/StageEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { type MessageKey, t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';
import type { AgentAvailability, AgentId, Command, StageAction } from '../../../types';
import { entryKey, entryKeys, entryLabel, fromKeys, isGateDraft, type StageDraft } from '@/lib/settings-stages';

// A stage's entra and executa blocks (#515); saídas is StageDetail's. Inputs are uncontrolled: StageDetail is keyed by the stage, so they reset
// when another stage is selected.

export interface BlockProps { id: string; stage: StageDraft; onUpdate(patch: Partial<StageDraft>): void }

/** A labelled field with its muted hint under it. */
export function Field({ id, anchor, label, hint, children }: { id: string; anchor?: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div id={anchor} className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** Entra: the entry columns of every source in one select, then when the stage may run, how many tasks show, how many run at once. */
export function StageEnter({ id, stage, sources, onUpdate }: BlockProps & { sources: StageSource[] }) {
  const options = sources.flatMap((b) => b.options.map((o) => entryKey(b.id, o)));
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_9rem_10rem]">
      <Field id={`${id}-from`} anchor={settingAnchor('settings.stages.from', stage.id)} label={t('settings.stages.from')} hint={t('settings.stages.from.hint')}>
        <MultiSelect
          ariaLabel={t('settings.stages.from')} value={entryKeys(stage.from, sources)} options={options} placeholder={t('settings.stages.from.add')}
          labelOf={(key) => entryLabel(key, sources)} onChange={(keys) => onUpdate({ from: fromKeys(keys) })}
        />
      </Field>
      <Field id={`${id}-after`} anchor={settingAnchor('settings.stages.after', stage.id)} label={t('settings.stages.after')} hint={t('settings.stages.after.hint')}>
        <Input id={`${id}-after`} placeholder={t('settings.stages.after.placeholder')} defaultValue={stage.after} onChange={(e) => onUpdate({ after: e.target.value })} />
      </Field>
      {/* #475, #755: a delete-activity or a commands stage runs no worker, so it has no cap to set */}
      <Field id={`${id}-maxWorkers`} anchor={settingAnchor('settings.stages.maxWorkers', stage.id)} label={t('settings.stages.maxWorkers')} hint={t('settings.stages.maxWorkers.hint')}>
        <Input
          id={`${id}-maxWorkers`} type="number" min={0} step={1} placeholder={t('settings.stages.maxWorkers.none')} disabled={stage.action !== ''}
          defaultValue={stage.maxWorkers} onChange={(e) => onUpdate({ maxWorkers: e.target.value })}
        />
      </Field>
    </div>
  );
}

type ActionValue = 'prompt' | 'gate' | StageAction;
const ACTION_LABEL: Record<ActionValue, MessageKey> = {
  prompt: 'settings.stages.action.prompt', commands: 'settings.stages.action.commands', waitForCi: 'settings.stages.action.waitForCi',
  gate: 'settings.stages.action.gate', deleteActivity: 'settings.stages.action.deleteActivity',
};
const ACTION_ICON: Record<ActionValue, LucideIcon> = { prompt: BotIcon, commands: ListChecksIcon, waitForCi: WorkflowIcon, gate: UserCheckIcon, deleteActivity: Trash2Icon };
const ACTIONS: readonly ActionValue[] = ['prompt', 'commands', 'waitForCi', 'gate', 'deleteActivity'];
// #134: só aprovação is a prompt stage that runs nothing, so it is the draft's gate with approval locked on
const picked = (value: string): Partial<StageDraft> =>
  (value === 'gate' ? { action: '', gate: true, approval: true } : { action: value === 'prompt' ? '' : (value as StageAction), gate: false });

/** Run a prompt, run the workspace's commands (#755), wait for the PR's CI (#834), only wait for approval (#134) or delete the activity (#58): the
 * stage's own action, each with its icon. delete activity's own hint (#524) shows only once chosen: a prompt stage needs no warning about a force it never runs. */
function ActionSelect({ id, stage, onUpdate }: BlockProps) {
  const value: ActionValue = isGateDraft(stage) ? 'gate' : stage.action === '' ? 'prompt' : stage.action;
  return (
    <Field id={`${id}-action`} anchor={settingAnchor('settings.stages.action', stage.id)} label={t('settings.stages.action')} hint={stage.action === 'deleteActivity' ? t('settings.stages.action.deleteActivity.hint') : undefined}>
      <Select value={value} onValueChange={(v) => onUpdate(picked(v))}>
        <SelectTrigger id={`${id}-action`} className="w-full"><SelectValue>{t(ACTION_LABEL[value])}</SelectValue></SelectTrigger>
        <SelectContent>
          {ACTIONS.map((a) => {
            const Icon = ACTION_ICON[a];
            return <SelectItem key={a} value={a}><Icon aria-hidden="true" />{t(ACTION_LABEL[a])}</SelectItem>;
          })}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The agents found on boot and the default a stage without its own pick runs (#516). */
export interface AgentProps { agents: readonly AgentAvailability[]; defaultAgent: AgentId }

/** Who runs the prompt, with which model and session. */
function WorkerFields({ id, stage, onUpdate, agents, defaultAgent }: BlockProps & AgentProps) {
  return (
    <>
      <Field id={`${id}-agent`} anchor={settingAnchor('settings.stages.agent', stage.id)} label={t('settings.stages.agent')}>
        <AgentSelect id={`${id}-agent`} value={stage.agent} agents={agents} defaultAgent={defaultAgent} onChange={(agent) => onUpdate({ agent })} />
      </Field>
      <Field id={`${id}-model`} anchor={settingAnchor('settings.stages.model', stage.id)} label={t('settings.stages.model')} hint={t('settings.stages.model.hint')}>
        <Input id={`${id}-model`} placeholder={t('settings.stages.model.placeholder')} defaultValue={stage.model} onChange={(e) => onUpdate({ model: e.target.value })} />
      </Field>
      <Field id={`${id}-session`} anchor={settingAnchor('settings.stages.session', stage.id)} label={t('settings.stages.session')}>
        <Select value={stage.session} onValueChange={(v) => onUpdate({ session: v as StageDraft['session'] })}>
          <SelectTrigger id={`${id}-session`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="new">{t('settings.stages.session.new')}</SelectItem>
            <SelectItem value="continue">{t('settings.stages.session.continue')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

/** A stage's switch with its label, and its muted hint under it (#268, #692). */
function StageSwitch({ id, anchor, label, hint, checked, disabled = false, onChange }: { id: string; anchor: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void }) {
  return (
    <div id={anchor} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
        <Label htmlFor={id}>{label}</Label>
      </div>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}

/** The Comb's commands a commands stage offers (#755) and the workspaces its names are checked against. */
export interface CommandsProps { commands: readonly Command[]; workspaces: readonly string[] }

/** Executa: the action and, on a prompt stage, the agent, model, session, prompt, the approval switch (#268) and the handoff switch (#692); on
 * a commands stage its commands block (#755), on a wait for CI its block (#834). */
export function StageRun({ id, stage, onUpdate, agents, defaultAgent, commands, workspaces }: BlockProps & AgentProps & CommandsProps) {
  const isGate = isGateDraft(stage);
  const runsPrompt = stage.action === '' && !isGate;
  const hasPrompt = stage.prompt.trim() !== ''; // #692: a stage without a prompt is a gate and never spawns, so the parser refuses a handoff there
  const handoffAllowed = stage.session !== 'continue' && hasPrompt;
  const handoffHint = stage.session === 'continue' ? 'settings.stages.handoff.continue' : hasPrompt ? 'settings.stages.handoff.hint' : 'settings.stages.handoff.noPrompt';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-4">
        <ActionSelect id={id} stage={stage} onUpdate={onUpdate} />
        {runsPrompt && <WorkerFields id={id} stage={stage} onUpdate={onUpdate} agents={agents} defaultAgent={defaultAgent} />}
      </div>
      {stage.action === 'commands' && <StageCommands id={id} stage={stage} options={commands} workspaces={workspaces} onUpdate={onUpdate} />}
      {stage.action === 'waitForCi' && <StageCi id={id} stage={stage} onUpdate={onUpdate} />}
      {isGate && (
        <>
          <p className="text-muted-foreground text-xs">{t('settings.stages.gate.note')}</p>
          <StageSwitch id={`${id}-approval`} anchor={settingAnchor('settings.stages.approval', stage.id)} label={t('settings.stages.approval')} hint={t('settings.stages.approval.hint')} checked disabled onChange={() => undefined} />
        </>
      )}
      {runsPrompt && (
        <>
          <Field id={`${id}-prompt`} anchor={settingAnchor('settings.stages.prompt', stage.id)} label={t('settings.stages.prompt')} hint={t('settings.stages.prompt.hint')}>
            <Textarea id={`${id}-prompt`} rows={3} spellCheck={false} defaultValue={stage.prompt} onChange={(e) => onUpdate({ prompt: e.target.value })} />
          </Field>
          <StageSwitch id={`${id}-approval`} anchor={settingAnchor('settings.stages.approval', stage.id)} label={t('settings.stages.approval')} hint={t('settings.stages.approval.hint')} checked={stage.approval} onChange={(approval) => onUpdate({ approval })} />
          {/* #692: a continued session already holds the previous stage's work, so the parser refuses a handoff there */}
          <StageSwitch
            id={`${id}-handoff`} anchor={settingAnchor('settings.stages.handoff', stage.id)} label={t('settings.stages.handoff')} checked={stage.handoff && handoffAllowed} disabled={!handoffAllowed}
            hint={t(handoffHint)} onChange={(handoff) => onUpdate({ handoff })}
          />
        </>
      )}
      {stage.action !== 'deleteActivity' && !isGate && <StageVerdicts id={id} stage={stage} onUpdate={onUpdate} />}
    </div>
  );
}
