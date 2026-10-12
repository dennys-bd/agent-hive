import { type RefObject, useContext } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { NEW_SESSION } from '../../types';
import { KeyHint } from '@/components/KeyHint';
import { agentName } from '../../agents';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { useReviewPane } from '@/components/review-context';
import { SessionLabel } from '@/components/SessionLabel';
import { StatusWord } from '@/components/StatusWord';
import { t } from '@/i18n';

/** A box the list is placed against: the typed @, measured in its field, stands in for an element. */
export interface VirtualAnchor { getBoundingClientRect(): DOMRect }

export interface MentionListProps {
  anchor: RefObject<VirtualAnchor>; field: RefObject<HTMLTextAreaElement | null>; listId: string;
  options: string[]; active: number; participants: string[]; onActive(index: number): void; onPick(id: string): void; onDismiss(): void;
}

export const optionId = (listId: string, index: number): string => `${listId}-${index}`;

// nesta conversa for a participant, else the session's status word and its dot
function RowSide({ id, participants }: { id: string; participants: string[] }) {
  const pane = useReviewPane();
  if (participants.includes(id)) return <span className="ml-auto text-muted-foreground">{t('review.inConversation')}</span>;
  const status = pane.sessions.find((s) => s.id === id)?.status;
  return status === undefined ? null : <span className="ml-auto"><StatusWord status={status} /></span>;
}

function Row({ id, participants }: { id: string; participants: string[] }) {
  const defaultAgent = useContext(DefaultAgentContext);
  if (id === NEW_SESSION) return <>{t('review.newSessionOf', { agent: agentName(defaultAgent) })}<KeyHint id="newSession" /></>;
  return <><SessionLabel id={id} /><RowSide id={id} participants={participants} /></>;
}

/** The task's sessions for an @ (#591): anchored at the @, below its line and flipped above when there is no room, the field keeping focus
 * so its keys move the selection. Esc belongs to the field, which closes the list without letting the comment box close too. */
export function MentionList({ anchor, field, listId, options, active, participants, onActive, onPick, onDismiss }: MentionListProps) {
  const pane = useReviewPane();
  const title = t('review.sessionsOf', { task: pane.task });
  return (
    <PopoverPrimitive.Root open modal={false} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <PopoverPrimitive.Anchor virtualRef={anchor} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom" align="start" sideOffset={2} collisionPadding={8} avoidCollisions
          onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => { if (e.target === field.current) e.preventDefault(); }}
          className="z-50 w-72 rounded-md border bg-popover p-1 font-sans text-popover-foreground text-xs shadow-md outline-hidden"
        >
          <div role="listbox" id={listId} aria-label={title}>
            <div className="px-2 py-1 text-muted-foreground">{title}</div>
            {options.map((id, index) => (
              <div
                key={id} id={optionId(listId, index)} role="option" aria-selected={index === active} tabIndex={-1}
                className={`flex cursor-default items-center gap-2 rounded-sm px-2 py-1 ${index === active ? 'bg-accent' : ''}`}
                onPointerEnter={() => onActive(index)} onMouseDown={(e) => { e.preventDefault(); onPick(id); }}
              >
                <Row id={id} participants={participants} />
              </div>
            ))}
          </div>
          <div className="mt-1 border-t px-2 pt-1 text-muted-foreground">{t('review.mentionHint')}</div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
