import { ChevronDownIcon } from 'lucide-react';
import { useContext, useState } from 'react';
import { agentName, isAvailable } from '../../../agents';
import { AGENT_IDS, type AgentId } from '../../../types';
import { ModelMenu } from '@/components/LaunchMenus';
import { AgentsContext } from '@/components/NewRunButton';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AssistPick } from '@/hooks/use-assist';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';

export interface AgentModelChipProps {
  pick: AssistPick; onPick(pick: AssistPick): void; workspace?: string; isDisabled?: boolean;
  defaultLabel?: string; onDefault?(): void; // an entry above the agents that goes back to a default (the reviewer's, #492)
  label: string; // the trigger's accessible name
}

/** The agent's mark in its own colour, as the launch menus' agent select draws it; the rest of the chip stays neutral. */
export const AgentMark = ({ agent }: { agent: AgentId }) => <AgentIcon agent={agent} className={`size-3.5 shrink-0 ${AGENT_COLOR[agent] ?? ''}`} />;

/** The agent and model chip (handoff 11k, #492): `<mark> agent · model` on accent, opening the available agents and the picked one's models.
 * GET /launch-options needs a workspace: its lists are read while the chip is open; another agent goes back to its CLI's default model. */
export function AgentModelChip({ pick, onPick, workspace, isDisabled = false, defaultLabel, onDefault, label }: AgentModelChipProps) {
  const agents = useContext(AgentsContext);
  const [isOpen, setOpen] = useState(false);
  const [isModelOpen, setModelOpen] = useState(false);
  const options = useLaunchOptions(isOpen ? workspace : undefined);
  const name = pick.model === '' ? agentName(pick.agent) : `${agentName(pick.agent)} · ${pick.model}`;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button" aria-label={label} title={label} disabled={isDisabled}
          className="inline-flex shrink-0 items-center gap-[5px] rounded bg-accent px-1.5 py-px text-xs disabled:opacity-50"
        >
          <AgentMark agent={pick.agent} />{name}<ChevronDownIcon aria-hidden="true" className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex w-64 flex-col gap-2 p-2">
        {onDefault && defaultLabel && <Button type="button" variant="ghost" size="xs" className="justify-start" onClick={onDefault}>{defaultLabel}</Button>}
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the agents */}
        <div role="group" aria-label={t('newSession.agent')} className="flex flex-col gap-0.5">
          {AGENT_IDS.filter((agent) => isAvailable(agent, agents)).map((agent) => (
            <Button key={agent} type="button" variant="ghost" size="xs" aria-pressed={agent === pick.agent} className="justify-start" onClick={() => onPick({ agent, model: agent === pick.agent ? pick.model : '' })}>
              <AgentMark agent={agent} />{agentName(agent)}
            </Button>
          ))}
        </div>
        <ModelMenu agent={pick.agent} options={options?.[pick.agent]} value={pick.model} open={isModelOpen} onOpenChange={setModelOpen} onPick={(model) => onPick({ ...pick, model })} />
      </PopoverContent>
    </Popover>
  );
}
