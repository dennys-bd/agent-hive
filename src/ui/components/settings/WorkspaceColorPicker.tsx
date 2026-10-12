import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { WORKSPACE_HEX_COLOR, WORKSPACE_PRESET_COLORS } from '../../../types';

interface WorkspaceColorPickerProps { id?: string; value: string; onChange(color: string): void }

const CUSTOM = WORKSPACE_PRESET_COLORS.length; // the 8th circle, after the presets
const COUNT = CUSTOM + 1;
const STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
const SELECTED = 'shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--foreground)]';
const CIRCLE = 'size-5 rounded-full';

interface CustomCircleProps { value: string; isSelected: boolean; tabIndex: number; circleRef(el: HTMLButtonElement | null): void; onOpen(): void }

// custom color (#78): a plus until a custom colour is the current one, then filled with it and ringed like a selected preset
function CustomCircle({ value, isSelected, tabIndex, circleRef, onOpen }: CustomCircleProps) {
  const label = t('settings.workspaces.customColor');
  return (
    <button
      ref={circleRef} type="button" role="option" aria-selected={isSelected} aria-label={label} title={label} tabIndex={tabIndex} onClick={onOpen}
      className={`${CIRCLE} flex items-center justify-center text-muted-foreground ${isSelected ? SELECTED : 'shadow-[inset_0_0_0_1px_var(--input)]'}`}
      style={isSelected ? { backgroundColor: value } : undefined}
    >
      {!isSelected && <PlusIcon aria-hidden="true" className="size-3.5" />}
    </button>
  );
}

function ColorTrigger({ id, value }: { id?: string; value: string }) {
  return (
    <PopoverTrigger asChild>
      <button id={id} type="button" aria-label={t('settings.workspaces.colorLabel')} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-transparent pr-2 pl-2.5 hover:bg-accent">
        <span aria-hidden="true" className="size-4 rounded-full" style={{ backgroundColor: value }} />
        <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground/50" />
      </button>
    </PopoverTrigger>
  );
}

/** A workspace's colour in its Settings card (#78): 7 presets and the system picker, in a popover. Roving focus: the arrows move between
 * the 8 circles and Enter (a button's own) picks. The popover owns Escape and the outside click. */
export function WorkspaceColorPicker({ id, value, onChange }: WorkspaceColorPickerProps) {
  const [open, setOpen] = useState(false);
  const preset = WORKSPACE_PRESET_COLORS.indexOf(value);
  const selected = preset === -1 ? CUSTOM : preset;
  const [focused, setFocused] = useState(selected);
  const circles = useRef<(HTMLButtonElement | null)[]>([]);
  const system: RefObject<HTMLInputElement | null> = useRef(null);
  const focusAt = (i: number): void => { setFocused(i); circles.current[i]?.focus(); };
  const onKeyDown = (event: KeyboardEvent): void => {
    const by = STEP[event.key];
    if (by === undefined) return;
    event.preventDefault();
    focusAt((focused + by + COUNT) % COUNT);
  };
  const pick = (color: string): void => { onChange(color); setOpen(false); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ColorTrigger id={id} value={value} />
      <PopoverContent align="start" sideOffset={4} className="w-auto p-2.5" onOpenAutoFocus={(e) => { e.preventDefault(); focusAt(selected); }}>
        <div role="listbox" aria-label={t('settings.workspaces.colors')} className="grid grid-cols-[repeat(8,20px)] gap-2" onKeyDown={onKeyDown}>
          {WORKSPACE_PRESET_COLORS.map((color, i) => (
            <button
              key={color} ref={(el) => { circles.current[i] = el; }} type="button" role="option" aria-selected={i === selected} aria-label={color}
              tabIndex={i === focused ? 0 : -1} className={`${CIRCLE} ${i === selected ? SELECTED : ''}`} style={{ backgroundColor: color }} onClick={() => pick(color)}
            />
          ))}
          <CustomCircle value={value} isSelected={selected === CUSTOM} tabIndex={focused === CUSTOM ? 0 : -1} circleRef={(el) => { circles.current[CUSTOM] = el; }} onOpen={() => system.current?.click()} />
        </div>
        {/* the system picker: inside the popover, so its own clicks are never outside; every input applies, the popover stays */}
        <input ref={system} type="color" aria-hidden="true" tabIndex={-1} className="sr-only" value={WORKSPACE_HEX_COLOR.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
      </PopoverContent>
    </Popover>
  );
}
