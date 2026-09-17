import { CheckIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';

interface FromMultiSelectProps { value: string[]; options: string[]; onChange(value: string[]): void }

/** The board columns a Hive column enters from: a value saved before "load" ran is kept, never silently dropped. */
export function FromMultiSelect({ value, options, onChange }: FromMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const all = [...options, ...value.filter((v) => !options.includes(v))];
  const toggle = (name: string): void => onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} className="h-auto min-h-9 w-full flex-wrap justify-start gap-1">
          {value.length ? value.map((v) => <Badge key={v} variant="secondary">{v}</Badge>) : t('setup.columns.none')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandList>
            <CommandGroup>
              {all.map((name) => (
                <CommandItem key={name} value={name} onSelect={() => toggle(name)} aria-selected={value.includes(name)}>
                  <CheckIcon className={value.includes(name) ? 'opacity-100' : 'opacity-0'} />
                  {name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
