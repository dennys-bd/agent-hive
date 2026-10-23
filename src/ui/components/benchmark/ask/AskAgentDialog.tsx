import { type KeyboardEvent, type ReactNode, useContext, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAvailable } from '../../../../agents.js';
import type { AgentId, Experiment } from '../../../../types.js';
import { ButtonKeyHint } from '@/components/KeyHint';
import { AgentField, ModelMenu } from '@/components/LaunchMenus';
import { AgentsContext, DefaultAgentContext } from '@/components/NewRunButton';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { statusOf } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { sendJson } from '@/lib/api';
import { pressed } from '@/lib/shortcut-bindings';

const DESCRIPTION_MAX = 4000; // the route's bound
const NONE = '__none__'; // a Radix item cannot hold ''
// A refusal's status as the toast's copy; the route logs the code, its words never reach the screen
const FAILED: Readonly<Record<number, MessageKey>> = { 400: 'benchmark.ask.failed.invalid', 404: 'benchmark.ask.failed.gone', 409: 'benchmark.ask.failed.mcpOff' };

/** partir de's start: the experiment the view shows, when it is live and in that workspace; else nenhum. */
export const startFrom = (selected: Experiment | undefined, workspace: string): string =>
  (selected !== undefined && selected.workspace === workspace && selected.archived !== true ? selected.id : NONE);

interface Picks { agent: AgentId; model: string }
interface Body { description: string; workspace: string; from: string; picks: Picks }

// The post and what follows it: the dialog closes on success; a refusal is a toast and the dialog stays
function useAskSubmit(onClose: () => void) {
  const [isPending, setPending] = useState(false);
  const submit = ({ description, workspace, from, picks }: Body): void => {
    if (isPending) return;
    setPending(true);
    const body = { description: description.trim(), workspace, ...(from === NONE ? {} : { from }), kind: picks.agent, ...(picks.model === '' ? {} : { model: picks.model }) };
    sendJson('POST', '/benchmark/agent', body).then(onClose, (err: unknown) => {
      setPending(false);
      toast.error(t(FAILED[statusOf(err)] ?? 'benchmark.ask.failed.unknown'));
    });
  };
  return { isPending, submit };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="self-center text-[13px] text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </>
  );
}

interface FieldsProps {
  experiments: readonly Experiment[]; workspaces: readonly string[]; workspace: string; from: string; picks: Picks;
  onWorkspace(workspace: string): void; onFrom(from: string): void; onPicks(picks: Picks): void;
}

// agente, modelo, workspace and partir de, in dlg-ask's grid
function AskFields({ experiments, workspaces, workspace, from, picks, onWorkspace, onFrom, onPicks }: FieldsProps) {
  const agents = useContext(AgentsContext);
  const options = useLaunchOptions(workspace);
  const [menu, setMenu] = useState<'agent' | 'model'>();
  const toggle = (which: 'agent' | 'model') => (isOpen: boolean): void => setMenu(isOpen ? which : undefined);
  const live = experiments.filter((e) => e.workspace === workspace && e.archived !== true);
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2">
      <Row label={t('benchmark.ask.agent')}>
        <AgentField id="ask-agent" label={t('benchmark.ask.agent')} value={picks.agent} agents={agents} onOpenChange={toggle('agent')} onChange={(agent) => onPicks({ agent, model: '' })} />
      </Row>
      <Row label={t('benchmark.ask.model')}>
        <ModelMenu id="ask-model" label={t('benchmark.ask.model')} agent={picks.agent} options={options?.[picks.agent]} value={picks.model} open={menu === 'model'} onOpenChange={toggle('model')} onPick={(model) => onPicks({ ...picks, model })} />
      </Row>
      <Row label={t('benchmark.ask.workspace')}>
        <Select value={workspace} onValueChange={onWorkspace}>
          <SelectTrigger aria-label={t('benchmark.ask.workspace')} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{workspaces.map((name) => <SelectItem key={name} value={name}><WorkspaceSquare name={name} />{name}</SelectItem>)}</SelectContent>
        </Select>
      </Row>
      <Row label={t('benchmark.ask.from')}>
        <Select value={from} onValueChange={onFrom}>
          <SelectTrigger aria-label={t('benchmark.ask.from')} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('benchmark.ask.none')}</SelectItem>
            {live.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>
    </div>
  );
}

interface AskAgentDialogProps { experiments: readonly Experiment[]; workspaces: readonly string[]; selected?: Experiment; onClose(): void }

/** Novo experimento com o agente (#478), dlg-ask of docs/agent/design/benchmark.hv.html: the description, the agent and the workspace, and the
 * experiment to start from. The post opens a local session that saves one draft; the view stays as it is. The confirm key submits. */
export function AskAgentDialog({ experiments, workspaces, selected, onClose }: AskAgentDialogProps) {
  const agents = useContext(AgentsContext);
  const [description, setDescription] = useState('');
  const [workspace, setWorkspace] = useState(() => (selected !== undefined && workspaces.includes(selected.workspace) ? selected.workspace : (workspaces[0] ?? '')));
  const [from, setFrom] = useState(() => startFrom(selected, workspace));
  const [picks, setPicks] = useState<Picks>({ agent: useContext(DefaultAgentContext), model: '' });
  const { isPending, submit } = useAskSubmit(onClose);
  const input = useRef<HTMLTextAreaElement>(null);
  const canSubmit = description.trim() !== '' && workspace !== '' && isAvailable(picks.agent, agents) && !isPending;
  const go = (): void => { if (canSubmit) submit({ description, workspace, from, picks }); };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (pressed(e.nativeEvent, 'confirm')) { e.preventDefault(); go(); }
  };
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[540px]" onKeyDown={onKeyDown} onOpenAutoFocus={(e) => { e.preventDefault(); input.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>{t('benchmark.ask.title')}</DialogTitle>
          <DialogDescription className="text-[13px]">{t('benchmark.ask.context')}</DialogDescription>
        </DialogHeader>
        <Textarea ref={input} aria-label={t('benchmark.ask.description')} value={description} maxLength={DESCRIPTION_MAX} rows={4} onChange={(e) => setDescription(e.target.value)} />
        <AskFields
          experiments={experiments} workspaces={workspaces} workspace={workspace} from={from} picks={picks} onPicks={setPicks} onFrom={setFrom}
          onWorkspace={(next) => { setWorkspace(next); setFrom(startFrom(selected, next)); }}
        />
        <p className="text-muted-foreground text-xs">{t('benchmark.ask.footer')}</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('benchmark.ask.cancel')}</Button>
          <Button type="button" disabled={!canSubmit} onClick={go}>{t('benchmark.ask.submit')}<ButtonKeyHint id="confirm" /></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
