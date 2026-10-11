// The find bar over a terminal (#12): a panel tab's, a split pane's or a detached window's. It searches the scrollback through xterm's
// search addon, highlights and counts the matches, and gives the focus back to the terminal on close.
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { pressed } from '@/lib/shortcut-bindings';
import { findOptions, HIGHLIGHT_LIMIT, onThemeChange } from '@/lib/xterm-setup';

/** What the addon reports after a search: the active match's index (-1 past the highlight limit) and how many there are. */
export interface FindResults { resultIndex: number; resultCount: number }

/** What a bar searches: a terminal and the search addon loaded on it (loadSearch). */
export interface FindTarget { term: Terminal; search: SearchAddon }

interface TerminalFindProps extends FindTarget { isOpen: boolean; request: number; onClose(): void }

/** The counter: nothing for an empty field or before the first results, "no results", 1000+ at the highlight limit, else "{n} of {total}".
 * The addon caps the count at the limit, so a count that reaches it means more matches, wherever the active one is. */
export function counterText(query: string, results: FindResults | undefined): string {
  if (query === '' || results === undefined) return '';
  if (results.resultCount === 0) return t('terminal.find.none');
  if (results.resultIndex === -1 || results.resultCount >= HIGHLIGHT_LIMIT) return `${HIGHLIGHT_LIMIT}+`;
  return t('terminal.find.count', { n: results.resultIndex + 1, total: results.resultCount });
}

/** A tab's find bar: what it searches once the xterm exists, whether it is open, and the request each press of the binding bumps, so a press
 * with the bar open focuses its field again. onFind and close keep one identity, so the xterm's effect never re-runs for them. */
export interface FindBar { target: FindTarget | undefined; setTarget(target: FindTarget | undefined): void; isOpen: boolean; request: number; onFind(): void; close(): void }

export function useFindBar(): FindBar {
  const [target, setTarget] = useState<FindTarget>();
  const [isOpen, setOpen] = useState(false);
  const [request, setRequest] = useState(0);
  const onFind = useCallback((): void => {
    setOpen(true);
    setRequest((n) => n + 1);
  }, []);
  const close = useCallback((): void => setOpen(false), []);
  return { target, setTarget, isOpen, request, onFind, close };
}

// A one-line selection seeds the field; a multi-line one would not fit a one-line field, so the last query stays
function selectedLine(term: Terminal): string | undefined {
  const text = term.hasSelection() ? term.getSelection() : '';
  return text === '' || text.includes('\n') ? undefined : text;
}

interface SeedArgs extends FindTarget { input: RefObject<HTMLInputElement | null>; isOpen: boolean; request: number; setQuery(query: string): void }

// Each press of the binding fills the field from the selection, else keeps the last query, searches it and selects it, so typing replaces
// it. Written to the field at once: select() must see the new text before the re-render. A new xterm under an open bar (its effect re-runs
// when a link setting changes) only searches again: the focus moves on a press, never behind the user's back.
function useSeed({ input, term, search, isOpen, request, setQuery }: SeedArgs): void {
  const handled = useRef(0);
  useEffect(() => {
    const field = input.current;
    if (!isOpen || request === 0 || field === null) return;
    const isPress = request !== handled.current;
    handled.current = request;
    const seed = isPress ? (selectedLine(term) ?? field.value) : field.value;
    field.value = seed;
    setQuery(seed);
    if (seed !== '') search.findNext(seed, findOptions(true));
    if (!isPress) return;
    field.focus();
    field.select();
  }, [input, term, search, isOpen, request, setQuery]);
}

// The addon's counts, for the bar's life: it reports them at each search, and on new output while highlights show
function useResults(search: SearchAddon): FindResults | undefined {
  const [results, setResults] = useState<FindResults>();
  useEffect(() => {
    const subscription = search.onDidChangeResults(setResults);
    return () => subscription.dispose();
  }, [search]);
  return results;
}

// Highlights take their colours at the search (findOptions): a theme switch with matches shown searches again, from the active match
function useThemeRepaint(search: SearchAddon, query: string): void {
  useEffect(() => (query === '' ? undefined : onThemeChange(() => {
    search.clearDecorations();
    search.findNext(query, findOptions(true));
  })), [search, query]);
}

// The bar's keys never reach the console drawer, the details panel or the terminal: both skip a prevented Escape (#426)
const consume = (event: KeyboardEvent): void => {
  event.preventDefault();
  event.stopPropagation();
};

// A click on a button leaves the focus in the field, where Enter and Escape act. A button reached with Tab keeps its Escape too: the bar's
// data-terminal-find is in the console drawer's and the details panel's OWNS_ESCAPE
const keepFocus = (event: MouseEvent): void => event.preventDefault();

/** The find bar, at the terminal's top right. Case-insensitive; Enter / Shift+Enter step, Escape or × close and clear the highlights, the
 * binding pressed in the field selects its text. Renders nothing while closed; it stays mounted, so a tab keeps its query. */
export function TerminalFind({ term, search, isOpen, request, onClose }: TerminalFindProps) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const results = useResults(search);
  useSeed({ input, term, search, isOpen, request, setQuery });
  useThemeRepaint(search, isOpen ? query : '');
  if (!isOpen) return null;
  const type = (text: string): void => {
    setQuery(text);
    if (text === '') search.clearDecorations();
    else search.findNext(text, findOptions(true));
  };
  const step = (isPrevious: boolean): void => {
    if (query === '') return;
    if (isPrevious) search.findPrevious(query, findOptions(false));
    else search.findNext(query, findOptions(false));
  };
  const close = (): void => {
    search.clearDecorations();
    term.focus();
    onClose();
  };
  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      consume(event);
      close();
    } else if (event.key === 'Enter' && event.target === input.current) {
      consume(event);
      step(event.shiftKey);
    } else if (pressed(event, 'findInTerminal')) {
      consume(event);
      input.current?.select();
    }
  };
  const button = { type: 'button', size: 'icon-xs', variant: 'ghost', onMouseDown: keepFocus, onKeyDown: onKey } as const;
  return (
    <div data-terminal-find="" className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      <Input
        ref={input} value={query} aria-label={t('terminal.find.field')} placeholder={t('terminal.find.field')}
        className="h-6 w-44 px-2 text-xs md:text-xs" onChange={(event) => type(event.target.value)} onKeyDown={onKey}
      />
      <span aria-live="polite" className="min-w-12 px-1 text-muted-foreground text-xs tabular-nums">{counterText(query, results)}</span>
      <Button {...button} aria-label={t('terminal.find.previous')} onClick={() => step(true)}><ChevronUpIcon /></Button>
      <Button {...button} aria-label={t('terminal.find.next')} onClick={() => step(false)}><ChevronDownIcon /></Button>
      <Button {...button} aria-label={t('terminal.find.close')} onClick={close}><XIcon /></Button>
    </div>
  );
}
