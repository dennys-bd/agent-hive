import { BotIcon, ListChecksIcon, type LucideIcon, Trash2Icon, UserCheckIcon, WorkflowIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AgentField, ModelMenu, SkillMenu, SpecializedAgentMenu } from '@/components/LaunchMenus';
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
import type { AgentAvailability, AgentId, AgentLaunchOptions, Command, LaunchOptions, StageAction } from '../../../types';
import { entryKey, entryKeys, entryLabel, fromKeys, isAgentDraft, isGateDraft, type StageDraft } from '@/lib/settings-stages';

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
      {/* #475, #755, #710: a delete-activity or a commands stage runs no worker, so it has no cap to set; a skill stage holds one */}
      <Field id={`${id}-maxWorkers`} anchor={settingAnchor('settings.stages.maxWorkers', stage.id)} label={t('settings.stages.maxWorkers')} hint={t('settings.stages.maxWorkers.hint')}>
        <Input
          id={`${id}-maxWorkers`} type="number" min={0} step={1} placeholder={t('settings.stages.maxWorkers.none')} disabled={stage.action !== '' && stage.action !== 'skill'}
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
  skill: 'settings.stages.action.skill',
};
const ACTION_ICON: Record<ActionValue, LucideIcon> = { prompt: BotIcon, commands: ListChecksIcon, waitForCi: WorkflowIcon, gate: UserCheckIcon, deleteActivity: Trash2Icon, skill: BotIcon };
const ACTIONS: readonly ActionValue[] = ['prompt', 'skill', 'commands', 'waitForCi', 'gate', 'deleteActivity'];
// #134: só aprovação is a prompt stage that runs nothing, so it is the draft's gate with approval locked on
const picked = (value: string): Partial<StageDraft> =>
  (value === 'gate' ? { action: '', gate: true, approval: true } : { action: value === 'prompt' ? '' : (value as StageAction), gate: false });

/** Run a prompt, run one of the Hive's skills (#710), run the workspace's commands (#755), wait for the PR's CI (#834), only wait for approval (#134) or delete the activity (#58): the
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

/** The agents found on boot and the default a stage without its own pick runs (#516), and the lists of the config's first workspace (#710). */
export interface AgentProps { agents: readonly AgentAvailability[]; defaultAgent: AgentId; launchOptions?: LaunchOptions }
/** Whether the stage may continue the previous session (#710): canContinueSession, from the stage's place in the fill order. */
export interface ContinueProps { canContinue: boolean }

type Menu = 'agent' | 'model' | 'specialized';

/** Who runs the stage (#710, the handoff's 2×2 grid): the Start dialog's agent with no default row (a stage with none shows the default picked),
 * model, session and specialized agent. Another agent clears the model and the specialized agent: both are named per agent (decision 8). */
function WorkerFields({ id, stage, onUpdate, agents, defaultAgent, launchOptions, canContinue }: BlockProps & AgentProps & ContinueProps) {
  const [menu, setMenu] = useState<Menu>();
  const toggle = (which: Menu) => (isOpen: boolean): void => setMenu(isOpen ? which : undefined);
  const agent = stage.agent === '' ? defaultAgent : stage.agent;
  const options = launchOptions?.[agent];
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field id={`${id}-agent`} anchor={settingAnchor('settings.stages.agent', stage.id)} label={t('settings.stages.agent')}>
        <AgentField id={`${id}-agent`} value={agent} agents={agents} onOpenChange={toggle('agent')} onChange={(picked) => onUpdate({ agent: picked, model: '', specializedAgent: '' })} />
      </Field>
      <Field id={`${id}-model`} anchor={settingAnchor('settings.stages.model', stage.id)} label={t('settings.stages.model')}>
        <ModelMenu id={`${id}-model`} agent={agent} options={options} value={stage.model} open={menu === 'model'} onOpenChange={toggle('model')} onPick={(model) => onUpdate({ model })} />
      </Field>
      <Field id={`${id}-session`} anchor={settingAnchor('settings.stages.session', stage.id)} label={t('settings.stages.session')}>
        <Select value={stage.session} onValueChange={(v) => onUpdate({ session: v as StageDraft['session'] })}>
          <SelectTrigger id={`${id}-session`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="new">{t('settings.stages.session.new')}</SelectItem>
            {/* #710: the first stage of its agent has no session of that agent to resume */}
            <SelectItem value="continue" disabled={!canContinue}>
              <span className="flex min-w-0 flex-col">
                <span>{t('settings.stages.session.continue')}</span>
                {!canContinue && <span className="truncate text-muted-foreground text-xs">{t('settings.stages.session.continue.none', { agent })}</span>}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field id={`${id}-specializedAgent`} anchor={settingAnchor('settings.stages.specializedAgent', stage.id)} label={t('settings.stages.specializedAgent')}>
        <SpecializedAgentMenu
          id={`${id}-specializedAgent`} agent={agent} agents={options?.specializedAgents} value={stage.specializedAgent} disabled={stage.action === '' && stage.prompt.trim() === ''}
          open={menu === 'specialized'} onOpenChange={toggle('specialized')} onPick={(specializedAgent) => onUpdate({ specializedAgent })}
        />
      </Field>
    </div>
  );
}

// skill (#710): the Hive skill a skill stage runs, from its workspace's list (decision 10)
function SkillField({ id, stage, onUpdate, options }: BlockProps & { options?: AgentLaunchOptions }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Field id={`${id}-skill`} anchor={settingAnchor('settings.stages.skill', stage.id)} label={t('settings.stages.skill')}>
      <div className="md:w-80"><SkillMenu id={`${id}-skill`} skills={options?.skills} value={stage.skill} open={isOpen} onOpenChange={setIsOpen} onPick={(skill) => onUpdate({ skill })} /></div>
    </Field>
  );
}

// The approval switch (#268) and the handoff switch (#692) of a stage that runs an agent. A blank prompt is a gate that never spawns, so the parser
// refuses a handoff there; a skill stage always runs one (#710)
function AgentSwitches({ id, stage, onUpdate }: BlockProps) {
  const hasRun = stage.action === 'skill' || stage.prompt.trim() !== '';
  const handoffAllowed = stage.session !== 'continue' && hasRun;
  const handoffHint = stage.session === 'continue' ? 'settings.stages.handoff.continue' : hasRun ? 'settings.stages.handoff.hint' : 'settings.stages.handoff.noPrompt';
  return (
    <>
      <StageSwitch id={`${id}-approval`} anchor={settingAnchor('settings.stages.approval', stage.id)} label={t('settings.stages.approval')} hint={t('settings.stages.approval.hint')} checked={stage.approval} onChange={(approval) => onUpdate({ approval })} />
      {/* #692: a continued session already holds the previous stage's work, so the parser refuses a handoff there */}
      <StageSwitch
        id={`${id}-handoff`} anchor={settingAnchor('settings.stages.handoff', stage.id)} label={t('settings.stages.handoff')} checked={stage.handoff && handoffAllowed} disabled={!handoffAllowed}
        hint={t(handoffHint)} onChange={(handoff) => onUpdate({ handoff })}
      />
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

/** Executa: the action; on a prompt or skill stage (#710) the run fields, the prompt or the skill, the approval switch (#268) and the handoff
 * switch (#692); on a commands stage its commands block (#755), on a wait for CI its block (#834). */
export function StageRun({ id, stage, onUpdate, agents, defaultAgent, launchOptions, canContinue, commands, workspaces }: BlockProps & AgentProps & ContinueProps & CommandsProps) {
  const isGate = isGateDraft(stage);
  const runsAgent = isAgentDraft(stage);
  const agent = stage.agent === '' ? defaultAgent : stage.agent;
  return (
    <div className="flex flex-col gap-3">
      <div className="md:w-56"><ActionSelect id={id} stage={stage} onUpdate={onUpdate} /></div>
      {runsAgent && <WorkerFields id={id} stage={stage} onUpdate={onUpdate} agents={agents} defaultAgent={defaultAgent} launchOptions={launchOptions} canContinue={canContinue} />}
      {stage.action === 'commands' && <StageCommands id={id} stage={stage} options={commands} workspaces={workspaces} onUpdate={onUpdate} />}
      {stage.action === 'waitForCi' && <StageCi id={id} stage={stage} onUpdate={onUpdate} />}
      {isGate && (
        <>
          <p className="text-muted-foreground text-xs">{t('settings.stages.gate.note')}</p>
          <StageSwitch id={`${id}-approval`} anchor={settingAnchor('settings.stages.approval', stage.id)} label={t('settings.stages.approval')} hint={t('settings.stages.approval.hint')} checked disabled onChange={() => undefined} />
        </>
      )}
      {stage.action === '' && !isGate && (
        <Field id={`${id}-prompt`} anchor={settingAnchor('settings.stages.prompt', stage.id)} label={t('settings.stages.prompt')} hint={t('settings.stages.prompt.hint')}>
          <Textarea id={`${id}-prompt`} rows={3} spellCheck={false} defaultValue={stage.prompt} onChange={(e) => onUpdate({ prompt: e.target.value })} />
        </Field>
      )}
      {stage.action === 'skill' && <SkillField id={id} stage={stage} onUpdate={onUpdate} options={launchOptions?.[agent]} />}
      {runsAgent && <AgentSwitches id={id} stage={stage} onUpdate={onUpdate} />}
      {stage.action !== 'deleteActivity' && !isGate && <StageVerdicts id={id} stage={stage} onUpdate={onUpdate} />}
    </div>
  );
}
