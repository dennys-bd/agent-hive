import type { ComponentType } from 'react';
import { SESSION_ID_CHARS } from '../../tasks';
import { type AgentId, NEW_SESSION } from '../../types';
import { ClaudeIcon } from '@/components/ClaudeIcon';
import { agentName, RUN_AGENT } from '@/components/NewRunButton';
import { t } from '@/i18n';

/** Each agent's own mark (#516, #591): the header's usage groups and every place a review names a session. Partial, so an agent added
 * without a logo still reads, by its name. */
export const AGENT_ICON: Partial<Record<AgentId, ComponentType<{ className?: string }>>> = { claude: ClaudeIcon };

const MARK = 'size-3.5 shrink-0';

/** The agent's icon (#516, #925), or nothing for an agent without one: every place that shows it names the agent beside it. */
export function AgentIcon({ agent, className = MARK }: { agent: AgentId; className?: string }) {
  const Icon = AGENT_ICON[agent];
  return Icon === undefined ? null : <Icon className={className} />;
}

/** The agent's icon, or its name when it has none; every session is claude's today (#489). */
export function AgentMark({ agent = RUN_AGENT }: { agent?: AgentId }) {
  const Icon = AGENT_ICON[agent];
  return Icon === undefined ? agentName(agent) : <Icon className={MARK} />;
}

/** A session as the review names it (#591): the agent's icon, the agent, the id's first 8 characters in mono; nova sessão for a new one. */
export function SessionLabel({ id }: { id: string }) {
  if (id === NEW_SESSION) return <>{t('review.newSession')}</>;
  const Icon = AGENT_ICON[RUN_AGENT];
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {Icon !== undefined && <Icon className={MARK} />}{agentName(RUN_AGENT)} <span className="font-mono">{id.slice(0, SESSION_ID_CHARS)}</span>
    </span>
  );
}

/** A mention chip (#591), drawn by a field's backdrop over its own text (chipText): @, the agent's icon over the em space the text keeps
 * for it, ·, four characters of the id; on ring at 15%. In the field's font and without padding, so it is exactly as wide as that text and
 * the caret after it stays true; the ring's shadow pads it without taking room. */
export function SessionChip({ text }: { text: string }) {
  const Icon = AGENT_ICON[RUN_AGENT];
  return (
    <span data-slot="mention-chip" className="rounded-sm bg-ring/15 text-ring ring-2 ring-ring/15">
      {text.slice(0, 1)}<span className="relative">{text.slice(1, 2)}{Icon !== undefined && <Icon className="absolute inset-0 m-auto size-[1em]" />}</span>{text.slice(2)}
    </span>
  );
}
