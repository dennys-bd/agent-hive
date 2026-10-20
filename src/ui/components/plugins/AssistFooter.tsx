import { ChevronDownIcon } from 'lucide-react';
import { type KeyboardEvent, useContext, useEffect, useRef, useState } from 'react';
import { agentName, isAvailable } from '../../../agents';
import { displayBinding } from '../../../shortcuts.js';
import { AGENT_IDS, type AgentId } from '../../../types';
import { ModelMenu } from '@/components/LaunchMenus';
import { AgentsContext } from '@/components/NewRunButton';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Assist, AssistPick } from '@/hooks/use-assist';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';
import { markedLines } from '@/lib/assist-view';
import { isSettingsClosed, onShortcutKey } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';

interface AssistFooterProps { assist: Assist; pick: AssistPick; onPick(pick: AssistPick): void; workspace?: string; isDisabled: boolean; onAsk(request: string): void }
interface ChipProps { pick: AssistPick; onPick(pick: AssistPick): void; workspace?: string; isDisabled: boolean }

// The agent's mark in its own colour, as the launch menus' agent select draws it; the rest of the chip stays neutral
const Mark = ({ agent }: { agent: AgentId }) => <AgentIcon agent={agent} className={`size-3.5 shrink-0 ${AGENT_COLOR[agent] ?? ''}`} />;

// The chip (handoff 11k): the available agents and the picked one's models. GET /launch-options needs a workspace: the first one's lists,
// read while the chip is open; another agent goes back to its CLI's default model
function AgentChip({ pick, onPick, workspace, isDisabled }: ChipProps) {
  const agents = useContext(AgentsContext);
  const [isOpen, setOpen] = useState(false);
  const [isModelOpen, setModelOpen] = useState(false);
  const options = useLaunchOptions(isOpen ? workspace : undefined);
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" aria-label={t('plugins.assist.chip')} title={t('plugins.assist.chip')} disabled={isDisabled} className="shrink-0 font-normal">
          <Mark agent={pick.agent} />{agentName(pick.agent)}
          {pick.model !== '' && <span className="font-mono text-muted-foreground">{pick.model}</span>}
          <ChevronDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex w-64 flex-col gap-2 p-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the agents */}
        <div role="group" aria-label={t('newSession.agent')} className="flex flex-col gap-0.5">
          {AGENT_IDS.filter((agent) => isAvailable(agent, agents)).map((agent) => (
            <Button key={agent} type="button" variant="ghost" size="xs" aria-pressed={agent === pick.agent} className="justify-start" onClick={() => onPick({ agent, model: agent === pick.agent ? pick.model : '' })}>
              <Mark agent={agent} />{agentName(agent)}
            </Button>
          ))}
        </div>
        <ModelMenu agent={pick.agent} options={options?.[pick.agent]} value={pick.model} open={isModelOpen} onOpenChange={setModelOpen} onPick={(model) => onPick({ ...pick, model })} />
      </PopoverContent>
    </Popover>
  );
}

// The answer line: the run in flight, the proposal's marked lines, or what an idle footer was left with (no change, a refusal)
function answerOf(assist: Assist): string | undefined {
  if (assist.status === 'running') return t('plugins.assist.running');
  if (assist.answer !== undefined) {
    const { from, to } = markedLines(assist.answer.hunk);
    return t('plugins.assist.marked', { from, to });
  }
  return assist.line === undefined ? undefined : t(assist.line);
}

function Exchange({ assist, agent }: { assist: Assist; agent: AgentId }) {
  const answer = answerOf(assist);
  return (
    <div className="flex flex-col gap-1">
      <p className="truncate font-mono">❯ {assist.request}</p>
      {answer !== undefined && <p role="status" className="flex items-center gap-1.5 text-muted-foreground"><AgentIcon agent={agent} />{answer}</p>}
      {assist.status === 'proposed' && (
        <div className="flex items-center gap-2">
          <Button type="button" size="xs" onClick={assist.accept}>{t('plugins.assist.accept')}</Button>
          <Button type="button" size="xs" variant="ghost" onClick={assist.discard}>{t('plugins.assist.discard')}</Button>
          <span className="text-muted-foreground">{t('plugins.assist.acceptNote')}</span>
        </div>
      )}
    </div>
  );
}

/** The skill editor's footer (#331, handoff 11k): once a request was sent, its line and the answer's, with accept and discard while a
 * proposal waits; then the agent chip and the field, the askAgent key muted on its right. Mounted only with the plugins view shown
 * (PluginsView), so ⌘I acts there; from the capture phase it wins over Monaco's own ⌘I. */
export function AssistFooter({ assist, pick, onPick, workspace, isDisabled, onAsk }: AssistFooterProps) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => onShortcutKey([[true, 'askAgent']], () => input.current?.focus(), isSettingsClosed), []);
  const keys = binding('askAgent');
  const send = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const request = draft.trim();
    if (request === '') return; // the route's schema refuses an empty request anyway
    onAsk(request);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2 text-xs">
      {assist.request !== undefined && <Exchange assist={assist} agent={pick.agent} />}
      <div className="flex items-center gap-2">
        <AgentChip pick={pick} onPick={onPick} workspace={workspace} isDisabled={isDisabled} />
        <div className="relative min-w-0 flex-1">
          <Input
            ref={input} aria-label={t('plugins.assist.placeholder')} placeholder={t('plugins.assist.placeholder')} value={draft} disabled={isDisabled || assist.status !== 'idle'}
            onChange={(event) => setDraft(event.target.value)} onKeyDown={send} className="h-7 pr-10 text-xs"
          />
          {keys && <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted-foreground tracking-widest">{displayBinding(keys, isMac())}</kbd>}
        </div>
      </div>
    </div>
  );
}
