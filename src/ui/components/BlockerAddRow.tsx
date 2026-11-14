import { type KeyboardEvent, useId, useState } from 'react';
import { readsRef, type RefGrammar } from '../../blocker-refs';
import type { BlockerChange, BlockerRef, ItemBlockers } from '../../types';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBlockerSearch } from '@/hooks/use-blocker-search';
import { t } from '@/i18n';
import { badRefText } from '@/lib/blocker-errors';

type Kind = BlockerChange['kind'];

/** A ref as the blockers section shows it (#57): `#12` for an issue of the item's own repository; `owner/repo#12`, a qualified `foo-12` and a
 * hive `HIVE-3` already carry their own form (#56), so a second `#` would read `#owner/repo#12`. */
export const shownBlockerId = (id: string): string => (/^\d+$/.test(id) ? `#${id}` : id);

interface Option { ref: string; label: string; title?: string; isTyped: boolean }

// The typed ref first, even with no find (an issue of another repository never is one); then the finds. The item itself and the refs already
// in the chosen list are left out: adding them is a self error or a no-op
function optionsOf(typed: string | undefined, found: readonly BlockerRef[], skip: ReadonlySet<string>): Option[] {
  const finds = found.filter((r) => !skip.has(r.id) && r.id !== typed)
    .map((r): Option => ({ ref: r.id, label: shownBlockerId(r.id), title: r.title, isTyped: false }));
  if (typed === undefined || skip.has(typed)) return finds;
  return [{ ref: typed, label: t('blockers.addRef', { id: shownBlockerId(typed) }), isTyped: true }, ...finds];
}

interface KindSelectProps { kind: Kind; isBusy: boolean; onKind(kind: Kind): void; onKeyDown(e: KeyboardEvent<HTMLElement>): void }

function KindSelect({ kind, isBusy, onKind, onKeyDown }: KindSelectProps) {
  return (
    <Select value={kind} disabled={isBusy} onValueChange={(v) => onKind(v === 'blocking' ? 'blocking' : 'blockedBy')}>
      <SelectTrigger size="sm" aria-label={t('blockers.kind')} className="h-6 shrink-0 gap-1 px-1.5 text-xs" onKeyDown={onKeyDown}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="blockedBy">{t('blockers.blockedBy')}</SelectItem>
        <SelectItem value="blocking">{t('blockers.blocking')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface SuggestionsProps { id: string; options: Option[]; active: number; isLoading: boolean; onActive(index: number): void; onPick(ref: string): void }

// Under the field, in the panel's flow; the field keeps the focus, so its keys move the highlight
function Suggestions({ id, options, active, isLoading, onActive, onPick }: SuggestionsProps) {
  return (
    <div role="listbox" id={id} aria-label={t('blockers.suggestions')} aria-busy={isLoading} className="flex flex-col rounded-md border bg-popover p-1">
      {options.map((o, index) => (
        <div
          key={o.ref} id={`${id}-${index}`} role="option" aria-selected={index === active} tabIndex={-1}
          className={`flex cursor-default items-center gap-2 rounded-sm px-2 py-1 ${index === active ? 'bg-accent' : ''}`}
          onPointerEnter={() => onActive(index)} onMouseDown={(e) => { e.preventDefault(); onPick(o.ref); }}
        >
          <span className="shrink-0 font-medium">{o.label}</span>
          {o.title !== undefined && <span className="min-w-0 flex-1 truncate text-muted-foreground" title={o.title}>{o.title}</span>}
        </div>
      ))}
    </div>
  );
}

export interface BlockerAddRowProps {
  source: string; itemId: string; selfId: string; blockers: ItemBlockers; isBusy: boolean;
  kind?: Kind; // #61: a fixed kind and no select: the Project's blocked-by cell only adds blocked-by
  grammar?: RefGrammar; // #810: the item's source type's ref forms; absent on a hive task, which reads only a task id
  onAdd(kind: Kind, ref: string): void; onCancel(): void;
}

/** The blockers section's add row (#57, handoff 3): the kind (blocked by first) unless the caller fixes it (#61), then the field and its suggestions. ↑/↓ move the highlight,
 * ↵ adds the highlighted suggestion or, with none, the typed ref; with neither it names the forms the item's source type reads,
 * under the field (#810). Escape closes the row. The field and the select own Escape, and the key is prevented, so the details panel never closes with it; an open select's Escape, already prevented by Radix, closes only the select. */
export function BlockerAddRow({ source, itemId, selfId, blockers, isBusy, kind: fixedKind, grammar, onAdd, onCancel }: BlockerAddRowProps) {
  const listId = useId();
  const [chosenKind, setKind] = useState<Kind>('blockedBy');
  const kind = fixedKind ?? chosenKind;
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string>(); // #810: ↵ with nothing to add, in the UI's language; typing again clears it
  // The highlighted option by its ref, not its index: a search answer that swaps the list never moves the highlight onto another issue
  const [activeRef, setActiveRef] = useState<string>();
  const { candidates, loading } = useBlockerSearch(source, itemId, text);
  const options = optionsOf(readsRef(grammar, text), candidates, new Set([selfId, ...blockers[kind].map((r) => r.id)]));
  const active = options.findIndex((o) => o.ref === activeRef); // -1: nothing highlighted
  const setActive = (index: number): void => setActiveRef(options[index]?.ref);
  // ↵ with no highlighted option and no typed ref picks undefined: nothing is sent, the forms are named instead (#810)
  const pick = (ref: string | undefined): void => {
    if (ref === undefined) setRefusal(badRefText(grammar));
    else if (!isBusy) onAdd(kind, ref);
  };
  const closeOnEscape = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.max(-1, Math.min(options.length - 1, active + step)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active >= 0 ? options[active]?.ref : options.find((o) => o.isTyped)?.ref);
    } else closeOnEscape(e);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {fixedKind === undefined && <KindSelect kind={kind} isBusy={isBusy} onKind={(k) => { setKind(k); setActive(-1); }} onKeyDown={closeOnEscape} />}
        <Input
          autoFocus role="combobox" aria-label={t('blockers.search')} placeholder={t('blockers.search')} value={text} readOnly={isBusy}
          aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="h-6 min-w-0 flex-1 px-2 text-xs md:text-xs" onChange={(e) => { setText(e.target.value); setActive(-1); setRefusal(undefined); }} onKeyDown={onKeyDown}
        />
      </div>
      {refusal !== undefined && <p role="alert" className="text-destructive text-xs">{refusal}</p>}
      {options.length > 0 && <Suggestions id={listId} options={options} active={active} isLoading={loading} onActive={setActive} onPick={pick} />}
    </div>
  );
}
