import { CheckIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';

interface MultiSelectProps {
  value: string[]; options: string[]; onChange(value: string[]): void;
  allowTyped?: boolean; // #245: a search box whose text, when no listed value equals it, is offered as "add <text>"
  ariaLabel?: string;
  labelOf?(value: string): string; // #515: what a value reads as on its chip and its option; the values themselves stay raw
  placeholder?: string; // shown with nothing picked; nenhum by default
}

const asIs = (value: string): string => value;

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A multi-select over loaded options: a stage's source columns, a filter rule's values (#245). A saved value that is not among them is
 * kept, never silently dropped. */
export function MultiSelect({ value, options, onChange, allowTyped = false, ariaLabel, labelOf = asIs, placeholder }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const all = [...options, ...value.filter((v) => !options.includes(v))];
  const typed = search.trim();
  const canAdd = allowTyped && typed !== '' && !all.some((name) => same(name, typed));
  const toggle = (name: string): void => onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  const add = (): void => { onChange([...value, typed]); setSearch(''); };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel} className="h-auto min-h-9 w-full flex-wrap justify-start gap-1">
          {value.length ? value.map((v) => <Badge key={v} variant="secondary">{labelOf(v)}</Badge>) : <span className="font-normal text-muted-foreground">{placeholder ?? t('settings.stages.none')}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0">
        {/* cmdk's own fuzzy filter would otherwise hide the typed group entirely once no option matches the search text: we filter nothing
            ourselves (all options always show; the typed entry is our own conditional), so cmdk's filter is only in the way here */}
        <Command shouldFilter={false}>
          {allowTyped && <CommandInput value={search} onValueChange={setSearch} placeholder={t('settings.filter.typed')} />}
          <CommandList>
            <CommandGroup>
              {all.map((name) => (
                <CommandItem key={name} value={name} onSelect={() => toggle(name)} aria-selected={value.includes(name)}>
                  <CheckIcon className={value.includes(name) ? 'opacity-100' : 'opacity-0'} />
                  {labelOf(name)}
                </CommandItem>
              ))}
              {canAdd && (
                // forceMount: cmdk would otherwise filter this item against the very text it offers
                <CommandItem forceMount value={`add:${typed}`} onSelect={add}>
                  <PlusIcon />
                  {t('settings.filter.addValue', { value: typed })}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
