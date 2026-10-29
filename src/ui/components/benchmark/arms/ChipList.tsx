import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';

export const CHIP_LIMIT = 7; // ponytail: "past one line" counted, not measured (jsdom has no layout); measure when a row's width varies

interface ChipListProps {
  id: string; addLabel: string; placeholder: string; value: readonly string[];
  onChange(value: string[]): void; isReadOnly?: boolean; limit?: number;
  options?: readonly string[]; // only these may be added (a datalist offers them); absent = any text
}

/** The screen's `.list`: mono chips with a ×, `mais N` past the limit, and a field that adds on Enter (#536). */
export function ChipList({ id, addLabel, placeholder, value, onChange, isReadOnly = false, limit = CHIP_LIMIT, options }: ChipListProps) {
  const [draft, setDraft] = useState('');
  const [isOpen, setOpen] = useState(false);
  const shown = isOpen ? value : value.slice(0, limit);
  const hidden = value.length - limit;
  const add = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // DialogBase must never see this Enter
    const chip = draft.trim();
    if (chip === '' || value.includes(chip) || (options !== undefined && !options.includes(chip))) return;
    onChange([...value, chip]);
    setDraft('');
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {value.length === 0 && <span className="text-muted-foreground">{t('benchmark.arms.settings.chips.none')}</span>}
      {shown.map((chip) => (
        <span key={chip} className="inline-flex items-center gap-1.5 rounded-[5px] border bg-background py-0.5 pr-1 pl-2 font-mono text-xs">
          {chip}
          {!isReadOnly && (
            <button
              type="button" aria-label={t('benchmark.arms.settings.chips.remove', { chip })}
              className="flex rounded-[3px] p-px text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onChange(value.filter((c) => c !== chip))}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          )}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" aria-expanded={isOpen} className="text-muted-foreground text-xs underline-offset-2 hover:underline" onClick={() => setOpen(!isOpen)}>
          {isOpen ? t('benchmark.arms.settings.chips.less') : t('benchmark.arms.settings.chips.more', { n: hidden })}
        </button>
      )}
      {!isReadOnly && (
        <>
          <Input
            id={id} aria-label={addLabel} placeholder={placeholder} value={draft} list={options === undefined ? undefined : `${id}-options`}
            className="h-auto w-[150px] flex-none px-2 py-0.5 font-mono text-xs" onChange={(e) => setDraft(e.target.value)} onKeyDown={add}
          />
          {options !== undefined && <datalist id={`${id}-options`}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
        </>
      )}
    </span>
  );
}
