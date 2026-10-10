import { type ChangeEvent, type KeyboardEvent, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react';
import { NEW_SESSION } from '../../types';
import { MentionList, optionId, type VirtualAnchor } from '@/components/MentionList';
import { sessionName, useReviewPane } from '@/components/review-context';
import { SessionChip } from '@/components/SessionLabel';
import { t } from '@/i18n';
import { caretRect } from '@/lib/caret';
import { type ChipText, chipText, matchesQuery, type MentionQuery, mentionAt, segmentsOf, stripMention, withChip } from '@/lib/mentions';
import { pressed } from '@/lib/shortcut-bindings';

interface MentionFieldProps {
  label: string; value: string; chips: string[]; participants?: string[]; autoFocus?: boolean;
  onChange(value: string, chips: string[]): void; onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
}

// What the textarea and its backdrop share, so the backdrop lays each character where the textarea does, a chip wrapping like a word. Both
// keep the scrollbar's room, so the text wraps alike before and after the field starts to scroll.
const LAYOUT = 'whitespace-pre-wrap break-words px-2 py-1 text-[13px] leading-[19px] [scrollbar-gutter:stable]';
// The field grows with its text up to 5 lines (5 × 19px and its 4px paddings), then scrolls
const HEIGHT = '[field-sizing:content] min-h-9 max-h-[103px] overflow-y-auto';
// A trailing zero-width space gives the backdrop the empty last line the textarea keeps after a final newline
const LAST_LINE = '\u200b';

const chipTextsOf = (chips: readonly string[]): ChipText[] => chips.map((id) => ({ id, text: chipText(id, t('review.newChip')) }));

// Each chip's text swapped between two labels of a new session's chip; a session's own chip reads alike in both
const relabel = (text: string, chips: readonly string[], from: string, to: string): string =>
  chips.reduce((rest, id) => rest.split(chipText(id, from)).join(chipText(id, to)), text);

/** What a mention field's message is stored as (#591): its text trimmed, each chip where it was written, a new session's reading "new" in
 * every language, so the server finds it. */
export const storedText = (value: string, chips: readonly string[]): string => relabel(value, chips, t('review.newChip'), NEW_SESSION).trim();

/** A stored text back in the field (#591): a new session's chip in the field's language. */
export const fieldText = (stored: string, chips: readonly string[]): string => relabel(stored, chips, NEW_SESSION, t('review.newChip'));

// The field's text drawn behind the transparent textarea (#591): plain runs as they are, chips in place of their text, as wide as it
function Backdrop({ value, chips, ref }: { value: string; chips: ChipText[]; ref: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={ref} aria-hidden="true" className={`${LAYOUT} pointer-events-none absolute inset-0 overflow-hidden text-foreground`}>
      {/* biome-ignore lint/suspicious/noArrayIndexKey: a segment is its place in the text, which is all that tells two alike apart */}
      {segmentsOf(value, chips).map((s, index) => (s.chip === undefined ? s.text : <SessionChip key={index} text={s.text} />))}
      {LAST_LINE}
    </div>
  );
}

// The caret a chip's insert or delete leaves, put back once React has written the new value, which moves it to the end
function useCaretAfter(field: RefObject<HTMLTextAreaElement | null>) {
  const caret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (caret.current === undefined) return;
    field.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  return caret;
}

// The chip whose text ends at the caret, when nothing is selected: Backspace there deletes it whole
function chipBefore(field: HTMLTextAreaElement, chips: ChipText[]): ChipText | undefined {
  const { selectionStart, selectionEnd, value } = field;
  return selectionStart === selectionEnd ? chips.find((c) => value.slice(0, selectionStart).endsWith(c.text)) : undefined;
}

// ↑ ↓ wrap around the list, so the last row is one key away from the first
const moved = (active: number, step: number, count: number): number => (active + step + count) % count;

interface ListKeys { options: string[]; active: number; pick(id: string): void; move(index: number): void; close(): void }

// The open list's keys; true when one was taken, so it reaches neither the field's send nor the comment box's Esc
function takeListKey(event: KeyboardEvent<HTMLTextAreaElement>, { options, active, pick, move, close }: ListKeys): boolean {
  if (pressed(event, 'newSession')) pick(NEW_SESSION);
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(moved(active, event.key === 'ArrowDown' ? 1 : -1, options.length));
  else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) pick(options[active]);
  else if (event.key === 'Escape') close();
  else return false;
  event.preventDefault();
  return true;
}

// The @ the list is open for, and which @ Esc closed: that one stays closed while it is typed on, so the typed text is kept as text
function useMention() {
  const [query, setQuery] = useState<MentionQuery>();
  const [dismissed, setDismissed] = useState<number>();
  const [active, setActive] = useState(0);
  const follow = (found: MentionQuery | undefined): void => {
    if (found === undefined) setDismissed(undefined);
    setQuery(found !== undefined && found.start !== dismissed ? found : undefined);
    setActive(0); // the first row, on opening and after each filter change
  };
  const close = (): void => { setDismissed(query?.start); setQuery(undefined); };
  return { query, active, setActive, follow, close, reset: () => setQuery(undefined) };
}

// The typed @ as the list's anchor: measured whenever the popper asks, so a scroll or a wrap moves the list with its @. `at` holds the @'s
// index, set by the change that opened it and read outside render.
function useAtAnchor(field: RefObject<HTMLTextAreaElement | null>) {
  const at = useRef(0);
  const anchor = useRef<VirtualAnchor>({
    getBoundingClientRect: () => {
      const box = field.current === null ? { left: 0, top: 0, height: 0 } : caretRect(field.current, at.current);
      return DOMRect.fromRect({ x: box.left, y: box.top, width: 0, height: box.height });
    },
  });
  return { at, anchor };
}

/** A review field with @ mentions (#591): a chip is a word of the text, at the @ it was picked from, drawn by the backdrop; Backspace right
 * after one deletes it whole, and text typed inside one breaks it back into characters. While the list is open its keys belong to it (↵
 * inserts, it never sends) and its wrapper carries data-shortcut-recording, so the page's newSession listener stands aside and the key
 * picks nova sessão. */
export function MentionField({ label, value, chips, participants = [], autoFocus, onChange, onKeyDown }: MentionFieldProps) {
  const pane = useReviewPane();
  const listId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const mention = useMention();
  const { query, active } = mention;
  const { at, anchor } = useAtAnchor(field);
  const caretAfter = useCaretAfter(field);
  const texts = chipTextsOf(chips);
  const options = query === undefined ? [] : [...pane.sessions.map((s) => s.id).filter((id) => matchesQuery(sessionName(id), query.query)), NEW_SESSION];
  // A chip whose text no longer reads whole in the field is gone
  const emit = (next: string): void => onChange(next, texts.filter((c) => next.includes(c.text)).map((c) => c.id));
  const pick = (id: string): void => {
    if (query === undefined) return;
    const chip = `${chipText(id, t('review.newChip'))} `;
    const rest = stripMention(value, query, query.start + query.query.length + 1);
    caretAfter.current = query.start + chip.length;
    onChange(rest.slice(0, query.start) + chip + rest.slice(query.start), withChip(chips, id));
    mention.reset();
  };
  const change = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const found = mentionAt(event.target.value, event.target.selectionStart);
    if (found !== undefined) at.current = found.start;
    mention.follow(found);
    emit(event.target.value);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (query !== undefined && takeListKey(event, { options, active, pick, move: mention.setActive, close: mention.close })) return;
    const chip = event.key === 'Backspace' ? chipBefore(event.currentTarget, texts) : undefined;
    if (chip !== undefined) {
      event.preventDefault();
      const end = event.currentTarget.selectionStart;
      caretAfter.current = end - chip.text.length;
      emit(value.slice(0, end - chip.text.length) + value.slice(end));
      return;
    }
    onKeyDown?.(event);
  };
  return (
    <div data-shortcut-recording={query === undefined ? undefined : ''}>
      {query !== undefined && (
        <MentionList
          anchor={anchor} field={field} listId={listId} options={options} active={active} participants={participants}
          onActive={mention.setActive} onPick={pick} onDismiss={mention.close}
        />
      )}
      <div className="relative rounded-md border focus-within:ring-1 focus-within:ring-ring">
        <Backdrop ref={backdrop} value={value} chips={texts} />
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the box opens for typing (#591)
          autoFocus={autoFocus}
          ref={field} aria-label={label} placeholder={label} value={value} onChange={change} onKeyDown={keyDown}
          onScroll={(event) => { if (backdrop.current !== null) backdrop.current.scrollTop = event.currentTarget.scrollTop; }}
          aria-controls={query === undefined ? undefined : listId} aria-activedescendant={query === undefined ? undefined : optionId(listId, active)}
          className={`${LAYOUT} ${HEIGHT} relative block w-full resize-none bg-transparent text-transparent caret-foreground outline-none selection:bg-ring/30 placeholder:text-muted-foreground`}
        />
      </div>
    </div>
  );
}
