import { ChevronRightIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { displayBinding } from '../../../shortcuts.js';
import type { AgentId } from '../../../types';
import { AgentMark, AgentModelChip } from '@/components/plugins/AgentModelChip';
import { Button } from '@/components/ui/button';
import type { Assist, AssistPick } from '@/hooks/use-assist';
import { t } from '@/i18n';
import { type LineSelection, markedLines } from '@/lib/assist-view';
import { isSettingsClosed, onShortcutKey } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';

/** #982: a request handed to the field from outside the bar (#981's "pedir ao agente"); n changes on every hand-off, so the same words twice
 * count twice. */
export interface Handoff { request: string; n: number }
interface AssistFooterProps {
  assist: Assist; pick: AssistPick; onPick(pick: AssistPick): void; workspace?: string; isDisabled: boolean; onAsk(request: string): boolean;
  passage?: LineSelection; onRelease?(): void; handoff?: Handoff; // #982: the editor's selection, its ×, and a hand-off from outside the bar
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

// #982: the lines a request will change, in the gutter's numbers, with × to let the selection go. The live region always stands, so a chip
// that comes or goes is announced
function PassageChip({ lines, onRelease }: { lines?: LineSelection; onRelease?(): void }) {
  return (
    <span aria-live="polite" className="contents">
      {lines !== undefined && (
        <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-[4px] border py-px pr-0.5 pl-1.5 text-xs">
          {lines.startLine === lines.endLine ? t('plugins.assist.passageLine', { n: lines.startLine }) : t('plugins.assist.passageLines', { from: lines.startLine, to: lines.endLine })}
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t('plugins.assist.release')} title={t('plugins.assist.release')} onClick={onRelease} className="size-4">
            <XIcon className="size-2.5" />
          </Button>
        </span>
      )}
    </span>
  );
}

/** The skill editor's footer (#331, handoff 11k): once a request was sent, its line and the answer's, with accept and discard while a
 * proposal waits; then one bordered field (#492) holding the agent chip, the input and the askAgent key muted on its right. #982: the editor's selection as a passage chip before the input, and a hand-off that fills and focuses it. Mounted only with the plugins view shown
 * (PluginsView), so ⌘I acts there; from the capture phase it wins over Monaco's own ⌘I. */
export function AssistFooter({ assist, pick, onPick, workspace, isDisabled, onAsk, passage, onRelease, handoff }: AssistFooterProps) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => onShortcutKey([[true, 'askAgent']], () => input.current?.focus(), isSettingsClosed), []);
  // A refused request (busy, unavailable, failed) hands the field its words back; "no change" was answered, so it stays empty
  useEffect(() => {
    if (assist.status === 'idle' && assist.line !== undefined && assist.line !== 'plugins.assist.noChange') setDraft((kept) => (kept === '' ? assist.request ?? '' : kept));
  }, [assist.status, assist.line, assist.request]);
  // #982: a hand-off gives the field its words and the focus; the holder makes a new object only on a new n
  useEffect(() => {
    if (handoff === undefined) return;
    setDraft(handoff.request);
    input.current?.focus();
  }, [handoff]);
  const keys = binding('askAgent');
  const send = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const request = draft.trim();
    if (request === '') return; // the route's schema refuses an empty request anyway
    if (onAsk(request)) setDraft('');
  };
  const isOff = isDisabled || assist.status !== 'idle';
  const shown = isOff ? undefined : passage; // a disabled field sends no request, so it names no lines
  const placeholder = t(shown === undefined ? 'plugins.assist.placeholder' : 'plugins.assist.placeholderPassage');
  return (
    <div className="flex flex-col gap-2 border-t px-4 pt-2.5 pb-3 text-xs">
      {assist.request !== undefined && <Exchange assist={assist} agent={pick.agent} />}
      <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 focus-within:border-ring">
        <AgentModelChip pick={pick} onPick={onPick} workspace={workspace} isDisabled={isDisabled} label={t('plugins.assist.chip')} />
        <PassageChip lines={shown} onRelease={() => { input.current?.focus(); onRelease?.(); }} />
        <input
          ref={input} aria-label={placeholder} placeholder={placeholder} value={draft} disabled={isOff}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={send}
          className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        {keys && <kbd className="pointer-events-none text-muted-foreground text-xs tracking-widest">{displayBinding(keys, isMac())}</kbd>}
      </div>
    </div>
  );
}
