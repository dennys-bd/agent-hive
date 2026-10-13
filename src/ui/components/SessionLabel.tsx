import type { ComponentType } from 'react';
import { agentName } from '../../agents';
import { SESSION_ID_CHARS } from '../../tasks';
import { type AgentId, NEW_SESSION } from '../../types';
import { ClaudeIcon } from '@/components/ClaudeIcon';
import { CodexIcon } from '@/components/CodexIcon';
import { useSessionAgent } from '@/components/review-context';
import { t } from '@/i18n';

/** Each agent's own mark (#516, #591): the footer's usage group (#223) and every place a review names a session. Partial, so an agent added
 * without a logo still reads, by its name. */
export const AGENT_ICON: Partial<Record<AgentId, ComponentType<{ className?: string }>>> = { claude: ClaudeIcon, codex: CodexIcon };

/** Each agent's own colour (#669), on its mark only: the footer's usage group, the +'s agents and the new session dialog's agent select (#257).
 * Partial, so an agent without one keeps currentColor. */
export const AGENT_COLOR: Partial<Record<AgentId, string>> = { claude: 'text-agent-claude', codex: 'text-agent-codex' };

const MARK = 'size-3.5 shrink-0';

/** The agent's icon (#516, #925), or nothing for an agent without one: every place that shows it names the agent beside it. */
export function AgentIcon({ agent, className = MARK }: { agent: AgentId; className?: string }) {
  const Icon = AGENT_ICON[agent];
  return Icon === undefined ? null : <Icon className={className} />;
}

/** A session as the review names it (#591, #925): its agent's icon and name, the id's first 8 characters in mono; nova sessão for a new one. */
export function SessionLabel({ id }: { id: string }) {
  const agent = useSessionAgent(id);
  if (id === NEW_SESSION) return <>{t('review.newSession')}</>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AgentIcon agent={agent} />{agentName(agent)} <span className="font-mono">{id.slice(0, SESSION_ID_CHARS)}</span>
    </span>
  );
}

/** A mention chip (#591), drawn by a field's backdrop over its own text (chipText): @, the icon of the agent session `id` ran (#925) over the
 * em space the text keeps for it, ·, four characters of the id; on ring at 15%. In the field's font and without padding, so it is exactly as
 * wide as that text and the caret after it stays true; the ring's shadow pads it without taking room. */
export function SessionChip({ id, text }: { id: string; text: string }) {
  const agent = useSessionAgent(id);
  return (
    <span data-slot="mention-chip" className="rounded-sm bg-ring/15 text-ring ring-2 ring-ring/15">
      {text.slice(0, 1)}<span className="relative">{text.slice(1, 2)}<AgentIcon agent={agent} className="absolute inset-0 m-auto size-[1em]" /></span>{text.slice(2)}
    </span>
  );
}
