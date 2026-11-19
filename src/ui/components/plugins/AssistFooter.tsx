import { ChevronRightIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { displayBinding } from '../../../shortcuts.js';
import type { AgentId } from '../../../types';
import { AgentMark, AgentModelChip } from '@/components/plugins/AgentModelChip';
import { Button } from '@/components/ui/button';
import type { Assist, AssistPick } from '@/hooks/use-assist';
import { t } from '@/i18n';
import { markedLines } from '@/lib/assist-view';
import { isSettingsClosed, onShortcutKey } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';

interface AssistFooterProps { assist: Assist; pick: AssistPick; onPick(pick: AssistPick): void; workspace?: string; isDisabled: boolean; onAsk(request: string): boolean }

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
    <div className="flex flex-col gap-1.5">
      <p className="flex items-start gap-2 text-soft"><ChevronRightIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{assist.request}</span></p>
      {answer !== undefined && <p role="status" className="flex items-center gap-2 text-muted-foreground"><AgentMark agent={agent} />{answer}</p>}
      {assist.status === 'proposed' && (
        <div className="flex items-center gap-2 pl-[22px]">
          <Button type="button" size="xs" onClick={assist.accept}>{t('plugins.assist.accept')}</Button>
          <Button type="button" size="xs" variant="outline" onClick={assist.discard}>{t('plugins.assist.discard')}</Button>
          <span className="text-muted-foreground">{t('plugins.assist.acceptNote')}</span>
        </div>
      )}
    </div>
  );
}

/** The skill editor's footer (#331, handoff 11k): once a request was sent, its line and the answer's, with accept and discard while a
 * proposal waits; then one bordered field (#492) holding the agent chip, the input and the askAgent key muted on its right. Mounted only with the plugins view shown
 * (PluginsView), so ⌘I acts there; from the capture phase it wins over Monaco's own ⌘I. */
export function AssistFooter({ assist, pick, onPick, workspace, isDisabled, onAsk }: AssistFooterProps) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => onShortcutKey([[true, 'askAgent']], () => input.current?.focus(), isSettingsClosed), []);
  // A refused request (busy, unavailable, failed) hands the field its words back; "no change" was answered, so it stays empty
  useEffect(() => {
    if (assist.status === 'idle' && assist.line !== undefined && assist.line !== 'plugins.assist.noChange') setDraft((kept) => (kept === '' ? assist.request ?? '' : kept));
  }, [assist.status, assist.line, assist.request]);
  const keys = binding('askAgent');
  const send = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const request = draft.trim();
    if (request === '') return; // the route's schema refuses an empty request anyway
    if (onAsk(request)) setDraft('');
  };
  return (
    <div className="flex flex-col gap-2 border-t px-4 pt-2.5 pb-3 text-xs">
      {assist.request !== undefined && <Exchange assist={assist} agent={pick.agent} />}
      <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 focus-within:border-ring">
        <AgentModelChip pick={pick} onPick={onPick} workspace={workspace} isDisabled={isDisabled} label={t('plugins.assist.chip')} />
        <input
          ref={input} aria-label={t('plugins.assist.placeholder')} placeholder={t('plugins.assist.placeholder')} value={draft} disabled={isDisabled || assist.status !== 'idle'}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={send}
          className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        {keys && <kbd className="pointer-events-none text-muted-foreground text-xs tracking-widest">{displayBinding(keys, isMac())}</kbd>}
      </div>
    </div>
  );
}
