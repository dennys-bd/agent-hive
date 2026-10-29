import { type ReactNode, useContext, useState } from 'react';
import { agentName } from '../../agents';
import { previousSession, worktreeSessions } from '../../tasks';
import type { LaunchOptions, LaunchPick, Session, State, Task } from '../../types';
import { AgentField, ModelMenu, SpecializedAgentMenu } from '@/components/LaunchMenus';
import { AgentsContext } from '@/components/NewRunButton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NEW_SESSION, PREVIOUS_SESSION, type RunField, type RunPicks } from '@/hooks/use-run-pick';
import { t } from '@/i18n';
import { AgentModelsContext } from '@/lib/agent-settings';
import { runsLine } from '@/lib/new-session';
import { elapsed } from '@/lib/usage';

type Menu = 'agent' | 'model' | 'specialized';
const SHORT_ID = 8;

/** How a session value reads in the field and in the summary (#290): nova, mesma da etapa anterior, or a session's short id. */
export const sessionText = (value: string): string =>
  (value === NEW_SESSION ? t('session.new') : value === PREVIOUS_SESSION ? t('run.session.previous') : value.slice(0, SHORT_ID));

// A row's stage part (#812): a free session named first, before any stage a feedback run gave it; — for a session with neither
const stageOfRow = (s: Session): string => [s.free ? t('detail.freeSession') : undefined, s.stages.at(-1)].filter((p) => p !== undefined).join(' · ') || '—';
const when = (iso: string): string => (iso === '' ? '—' : new Date(iso).toLocaleString());

// A field: its label (13px muted) with alterado at its right once it differs from the stage's; outside the label, so the control keeps its name
function Field({ label, htmlFor, isChanged, isWide = false, children }: { label: string; htmlFor?: string; isChanged: boolean; isWide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${isWide ? 'col-span-2' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="font-normal text-[13px] text-muted-foreground">{label}</Label>
        {isChanged && <span className="text-muted-foreground text-xs">{t('run.changed')}</span>}
      </div>
      {children}
    </div>
  );
}

// sessão (#290): new; the previous stage's session with its second line, disabled with none or when another agent recorded it (#925); then the
// activity's other sessions the picked agent can resume, newest first. Radix has no submenu: they are a labelled group
function SessionField({ id, task, state, picks, onPick }: { id: string; task?: Task; state: State; picks: RunPicks; onPick(session: string): void }) {
  const previous = task === undefined ? undefined : previousSession(task, state);
  const others = task === undefined ? [] : [...worktreeSessions(task, state)].reverse().filter((s) => s.agent === picks.agent && s.id !== previous?.id);
  return (
    <Select value={picks.session} onValueChange={onPick}>
      <SelectTrigger id={id} className="w-full"><SelectValue>{sessionText(picks.session)}</SelectValue></SelectTrigger>
      <SelectContent>
        <SelectItem value={NEW_SESSION}>
          <span className="flex min-w-0 flex-col">
            <span>{t('session.new')}</span>
            <span className="truncate text-muted-foreground text-xs">{t('run.session.newHint')}</span>
          </span>
        </SelectItem>
        <SelectItem value={PREVIOUS_SESSION} disabled={previous?.agent !== picks.agent}>
          <span className="flex min-w-0 flex-col">
            <span>{t('run.session.previous')}</span>
            {previous && <span className="truncate text-muted-foreground text-xs">{t('run.session.previousHint', { stage: previous.stages.at(-1) ?? '—', agent: agentName(previous.agent), time: elapsed(previous.lastUsedAt) })}</span>}
          </span>
        </SelectItem>
        {others.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t('run.session.other')}</SelectLabel>
            {others.map((s) => <SelectItem key={s.id} value={s.id}>{t('session.row', { id: s.id.slice(0, SHORT_ID), stage: stageOfRow(s), time: when(s.startedAt) })}</SelectItem>)}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

export interface RunFieldsProps {
  id: string; task?: Task; state: State; picks: RunPicks; options?: LaunchOptions;
  initial?: RunPicks; // the personalizar block's: a field that differs from it shows alterado
  stageModel?: string; // a stage run's: what its empty model resolves to (runModel), named as the stage's default
  locked?: LaunchPick; // a free resume's own picks (#257): model, specialized agent and args show them, disabled
  onPicks(change: Partial<RunPicks>): void;
}

/** The run's five fields (#290, handoff "Campos de execução"): agent and model, session and specialized agent, then the arguments across with
 * the command line they make. Sessão livre shows them always; executar etapas inside personalizar. */
export function RunFields({ id, task, state, picks, options, initial, stageModel, locked, onPicks }: RunFieldsProps) {
  const agents = useContext(AgentsContext);
  const models = useContext(AgentModelsContext);
  const [menu, setMenu] = useState<Menu>();
  const toggle = (which: Menu) => (isOpen: boolean): void => setMenu(isOpen ? which : undefined);
  const changed = (field: RunField): boolean => initial !== undefined && picks[field] !== initial[field];
  const isLocked = locked !== undefined;
  const shown: RunPicks = locked === undefined ? picks : { ...picks, model: locked.model ?? '', specializedAgent: locked.specializedAgent ?? '', args: (locked.args ?? []).join(' ') };
  const ofAgent = options?.[picks.agent];
  const line = runsLine({ ...shown, model: shown.model || stageModel || (models[picks.agent] ?? '') }, ofAgent?.args ?? []);
  const defaultLabel = stageModel === undefined ? undefined : t('run.model.stage', { model: stageModel });
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Field label={t('newSession.agent')} htmlFor={`${id}-agent`} isChanged={changed('agent')}>
        <AgentField id={`${id}-agent`} value={picks.agent} agents={agents} onOpenChange={toggle('agent')} onChange={(agent) => onPicks({ agent })} />
      </Field>
      <Field label={t('newSession.model')} isChanged={changed('model')}>
        <ModelMenu agent={picks.agent} options={ofAgent} value={shown.model} defaultLabel={defaultLabel} disabled={isLocked} open={menu === 'model'} onOpenChange={toggle('model')} onPick={(model) => onPicks({ model })} />
      </Field>
      <Field label={t('session.pick')} htmlFor={`${id}-session`} isChanged={changed('session')}>
        <SessionField id={`${id}-session`} task={task} state={state} picks={picks} onPick={(session) => onPicks({ session })} />
      </Field>
      <Field label={t('newSession.specializedAgent')} isChanged={changed('specializedAgent')}>
        <SpecializedAgentMenu agent={picks.agent} agents={ofAgent?.specializedAgents} value={shown.specializedAgent} disabled={isLocked} open={menu === 'specialized'} onOpenChange={toggle('specialized')} onPick={(specializedAgent) => onPicks({ specializedAgent })} />
      </Field>
      <Field label={t('newSession.args')} htmlFor={`${id}-args`} isChanged={changed('args')} isWide>
        <Input id={`${id}-args`} value={shown.args} disabled={isLocked} onChange={(e) => onPicks({ args: e.target.value })} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
        <p className="truncate font-mono text-muted-foreground text-xs" title={line}>{line}</p>
      </Field>
    </div>
  );
}
