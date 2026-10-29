import { type KeyboardEvent, type ReactNode, useContext, useState } from 'react';
import { isAvailable } from '../../agents';
import { taskLabel } from '../../tasks';
import type { AgentAvailability, AgentId, LaunchOptions, LaunchPick } from '../../types';
import { AgentField, ModelMenu, SpecializedAgentMenu } from '@/components/LaunchMenus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';
import { AgentModelsContext } from '@/lib/agent-settings';
import type { RunTarget } from '@/lib/activities';
import { launchOf, runsLine, type SessionPicks } from '@/lib/new-session';

type Menu = 'agent' | 'model' | 'specialized';
const AGENT_ID = 'new-session-agent';
const ARGS_ID = 'new-session-args';

// cancel and × keep their own Enter: they close
const isCloser = (target: EventTarget): boolean => target instanceof Element && target.closest('[data-slot="dialog-close"], [data-closer]') !== null;
// The header's line: the task, or a local activity's workspace. The summary's "in": the task's branch, or that workspace
const subtitleOf = (target: RunTarget): string => (target.kind === 'local' ? target.workspace : taskLabel(target.task));
const placeOf = (target: RunTarget): string => (target.kind === 'local' ? target.workspace : target.activity.branch ?? target.activity.workspace);

function Field({ label, htmlFor, isWide = false, children }: { label: string; htmlFor?: string; isWide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${isWide ? 'col-span-2' : ''}`}>
      <Label htmlFor={htmlFor} className="font-normal text-[13px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// The summary box (handoff §2): what will run, in mono, and where
function Summary({ runs, place }: { runs: string; place: string }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 rounded-md border p-2.5 text-xs">
      <span className="text-muted-foreground">{t('newSession.runs')}</span>
      <span className="min-w-0 truncate font-mono" title={runs}>{runs}</span>
      <span className="text-muted-foreground">{t('newSession.in')}</span>
      <span className="min-w-0 truncate font-mono">{place}</span>
    </div>
  );
}

interface FieldsProps { picks: SessionPicks; options?: LaunchOptions; agents: readonly AgentAvailability[]; menu?: Menu; onMenu(menu?: Menu): void; onPicks(change: Partial<SessionPicks>): void }

// The four fields in the handoff's grid: agent and model side by side, the specialized agent and the arguments across
function Fields({ picks, options, agents, menu, onMenu, onPicks }: FieldsProps) {
  const ofAgent = options?.[picks.agent];
  const toggle = (which: Menu) => (isOpen: boolean): void => onMenu(isOpen ? which : undefined);
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Field label={t('newSession.agent')} htmlFor={AGENT_ID}>
        {/* another agent's models mean nothing here: the model goes back to the default */}
        <AgentField id={AGENT_ID} value={picks.agent} agents={agents} onOpenChange={toggle('agent')} onChange={(agent) => onPicks({ agent, model: '' })} />
      </Field>
      <Field label={t('newSession.model')}>
        <ModelMenu agent={picks.agent} options={ofAgent} value={picks.model} open={menu === 'model'} onOpenChange={toggle('model')} onPick={(model) => onPicks({ model })} />
      </Field>
      <Field label={t('newSession.specializedAgent')} isWide>
        <SpecializedAgentMenu agent={picks.agent} agents={ofAgent?.specializedAgents} value={picks.specializedAgent} open={menu === 'specialized'} onOpenChange={toggle('specialized')} onPick={(specializedAgent) => onPicks({ specializedAgent })} />
      </Field>
      <Field label={t('newSession.args')} htmlFor={ARGS_ID} isWide>
        <Input id={ARGS_ID} value={picks.args} onChange={(e) => onPicks({ args: e.target.value })} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
        <p className="truncate text-muted-foreground text-xs">{t('newSession.args.global')} <span className="font-mono">{(ofAgent?.args ?? []).join(' ') || '—'}</span></p>
      </Field>
    </div>
  );
}

interface NewSessionDialogProps { target: RunTarget; defaultAgent: AgentId; agents: readonly AgentAvailability[]; onOpen(agent: AgentId, launch: LaunchPick): void; onClose(): void }

/** Nova sessão (#257, handoff §2): a free session in the activity with a picked agent, model, specialized agent and arguments, only for this
 * session (the config is never written). Enter opens from any field while no menu is open; Esc, × or cancel closes. */
export function NewSessionDialog({ target, defaultAgent, agents, onOpen, onClose }: NewSessionDialogProps) {
  const options = useLaunchOptions(target.kind === 'local' ? target.workspace : target.activity.workspace); // #316: the agents its workspace gets
  const [picks, setPicks] = useState<SessionPicks>({ agent: defaultAgent, model: '', specializedAgent: '', args: '' });
  const [menu, setMenu] = useState<Menu>();
  const models = useContext(AgentModelsContext);
  const canOpen = isAvailable(picks.agent, agents);
  const open = (): void => {
    if (!canOpen) return;
    onOpen(picks.agent, launchOf(picks));
    onClose();
  };
  // In the capture phase, so the agent select's own Enter (which would open it) never runs; a menu that is open keeps its Enter
  const onEnter = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || menu !== undefined || isCloser(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[540px]" onKeyDownCapture={onEnter}>
        <DialogHeader>
          <DialogTitle>{t('newSession.title')}</DialogTitle>
          <DialogDescription className="text-[13px]">{subtitleOf(target)}</DialogDescription>
        </DialogHeader>
        <Fields picks={picks} options={options} agents={agents} menu={menu} onMenu={setMenu} onPicks={(change) => setPicks((p) => ({ ...p, ...change }))} />
        <Summary runs={runsLine({ ...picks, model: picks.model || (models[picks.agent] ?? '') }, options?.[picks.agent].args ?? [])} place={placeOf(target)} />
        <DialogFooter>
          <Button type="button" variant="outline" data-closer onClick={onClose}>{t('newSession.cancel')}</Button>
          <Button type="button" disabled={!canOpen} onClick={open}>{t('newSession.open')} ↵</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
