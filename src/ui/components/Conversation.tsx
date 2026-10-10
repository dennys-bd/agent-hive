import { type KeyboardEvent, useState } from 'react';
import { SESSION_ID_CHARS } from '../../tasks';
import { storedText } from '@/components/MentionField';
import { agentName, RUN_AGENT } from '@/components/NewRunButton';
import { BOX, lineLabel } from '@/components/review-context';
import { useReviewSurface } from '@/components/review-surface';
import { ReviewField } from '@/components/ReviewField';
import { AgentMark, SessionChip } from '@/components/SessionLabel';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { chipText, segmentsOf } from '@/lib/mentions';
import type { SurfaceConversation, SurfaceMessage } from '@/lib/surface';

const time = (at: string): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Who wrote a message (#591, #592): você; the agent's icon and name in 500, then the session's id; or a GitHub login in 500. The time muted, a · between
function Author({ author, at }: Pick<SurfaceMessage, 'author' | 'at'>) {
  if (author.kind === 'session') {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-foreground"><AgentMark />{agentName(RUN_AGENT)}</span>
        <span className="text-muted-foreground">{`${author.session.slice(0, SESSION_ID_CHARS)} · ${time(at)}`}</span>
      </span>
    );
  }
  const name = author.kind === 'you' ? t('review.you') : author.login;
  return <span className="text-xs"><span className="font-medium text-foreground">{name}</span> <span className="text-muted-foreground">{`· ${time(at)}`}</span></span>;
}

// A message's text with its chips where they were written, drawn as the field draws them; a new session's in the pane's language. Plain text
// on GitHub: no Markdown rendering (#592)
function MessageText({ message }: { message: SurfaceMessage }) {
  const chips = (message.mentions ?? []).map((id) => ({ id, text: chipText(id) }));
  return (
    <span className="whitespace-pre-wrap">
      {/* biome-ignore lint/suspicious/noArrayIndexKey: a segment is its place in the text, which is all that tells two alike apart */}
      {segmentsOf(message.text, chips).map((s, index) => (s.chip === undefined ? s.text : <SessionChip key={index} text={chipText(s.chip, t('review.newChip'))} />))}
    </span>
  );
}

function Message({ conversation, message }: { conversation: SurfaceConversation; message: SurfaceMessage }) {
  const { sessions } = useReviewSurface();
  // ponytail: the conversation's last message while any send of the pane is out; exact ids once the routes take a client-made message id
  const isInFlight = sessions?.isSending === true && conversation.messages.at(-1)?.id === message.id;
  return (
    <li className="flex flex-col">
      <Author author={message.author} at={message.at} />
      <MessageText message={message} />
      {message.failed && sessions !== undefined && !isInFlight && (
        <span className="flex items-center gap-2 text-xs">
          <span className="text-destructive">{t('review.notDelivered')}</span>
          <Button type="button" size="xs" variant="link" onClick={() => sessions.retry(conversation.id, message.id)}>{t('review.resend')}</Button>
        </span>
      )}
    </li>
  );
}

// The reply field (#591): ↵ sends, to its chips on the diff pane, else to the reply target (the server's replyTarget); Shift+↵ is a new line
function ReplyField({ conversation }: { conversation: SurfaceConversation }) {
  const surface = useReviewSurface();
  const [text, setText] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const body = storedText(text, chips);
    if (event.key !== 'Enter' || event.shiftKey || body === '') return;
    event.preventDefault();
    setText('');
    setChips([]);
    void surface.reply(conversation.id, body, chips.length > 0 ? chips : undefined);
  };
  return (
    <div className="mt-2">
      <ReviewField label={t('review.reply')} value={text} chips={chips} participants={conversation.participants} onChange={(next, picked) => { setText(next); setChips(picked); }} onKeyDown={onKeyDown} />
    </div>
  );
}

// A conversation's head (#591): conversa, its lines (none on a GitHub file thread, #592), desatualizado when its lines changed
function Head({ conversation, isOutdated }: { conversation: SurfaceConversation; isOutdated: boolean }) {
  return (
    <>
      <span className="font-medium text-foreground">{t('review.conversation')}</span>
      {conversation.fileLevel !== true && <span>{lineLabel(conversation.anchor)}</span>}
      {isOutdated && <span className="rounded-md border px-1.5">{t('review.outdated')}</span>}
    </>
  );
}

/** A conversation under its anchor (#591, #592): conversa, its lines, who answers now and resolver; the messages across the box's width; a reply
 * field (↵). Resolved, it folds to one line that reopens it. Read only: no resolver, reabrir or reply. A fieldset carries role="group" (#512). */
export function Conversation({ conversation, isOutdated = false }: { conversation: SurfaceConversation; isOutdated?: boolean }) {
  const surface = useReviewSurface();
  const resolve = (resolved: boolean): void => { void surface.resolve(conversation.id, resolved); };
  if (conversation.resolved) {
    return (
      <fieldset aria-label={t('review.conversation')} className={`${BOX} flex min-w-0 items-center gap-2 text-muted-foreground text-xs`}>
        <Head conversation={conversation} isOutdated={isOutdated} /><span>· {t('review.resolved')}</span>
        {!surface.readOnly && <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={() => resolve(false)}>{t('review.reopen')}</Button>}
      </fieldset>
    );
  }
  return (
    <fieldset aria-label={t('review.conversation')} className={`${BOX} min-w-0`}>
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Head conversation={conversation} isOutdated={isOutdated} />
        {(conversation.replying ?? []).map((id) => (
          <span key={id} className="flex items-center gap-1"><span aria-hidden="true" className="size-1.5 rounded-full bg-working" />{t('review.replying', { agent: agentName(RUN_AGENT) })}</span>
        ))}
        {!surface.readOnly && <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={() => resolve(true)}>{t('review.resolve')}</Button>}
      </div>
      <ol className="mt-1 flex flex-col gap-2">{conversation.messages.map((m) => <Message key={m.id} conversation={conversation} message={m} />)}</ol>
      {conversation.more === true && <p className="mt-1 text-muted-foreground text-xs">{t('review.moreComments')}</p>}{/* GitHub holds more than the 100 comments read (#592) */}
      {!surface.readOnly && <ReplyField conversation={conversation} />}
    </fieldset>
  );
}
