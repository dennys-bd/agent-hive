import { XIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Button } from '@/components/ui/button';
import { t, type MessageKey } from '@/i18n';
import { cardEntries, type SettingEntry, settingAnchor } from '@/lib/settings-search';
import { isMac } from '@/lib/shortcut-bindings';
import { type FixedShortcut, SHORTCUT_MAP, SHORTCUT_SCOPES, type ShortcutDef, type ShortcutScope, shortcutDef } from '../../../shortcut-registry';
import { bindingFromEvent, defaultBinding, displayBinding, displayKeys, effectiveBindings, fixedKeys, takesTerminalKey } from '../../../shortcuts';
import type { OperationId, Shortcuts } from '../../../types';

interface ShortcutsTabProps {
  shortcuts: Shortcuts;
  onChange(shortcuts: Shortcuts): void;
}

// A modifier pressed alone is the start of a combination, never one: the field keeps recording.
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta'];

// The map with `id` bound to `next` (null = off). Undefined (Restaurar), or a binding equal to this platform's default (#585), drops the id:
// the config only ever holds the user's changes (#449).
function withBinding(shortcuts: Shortcuts, id: OperationId, next: string | null | undefined, mac: boolean): Shortcuts {
  const rest = Object.fromEntries(Object.entries(shortcuts).filter(([key]) => key !== id)) as Shortcuts;
  return next === undefined || next === defaultBinding(shortcutDef(id), mac) ? rest : { ...rest, [id]: next };
}

interface KeyFieldProps { def: ShortcutDef; binding: string | null; onRecord(binding: string): void }

// The binding in the platform's symbols, or Desligado. A click starts recording (#513), focus alone does not: tabbing through the chips
// never starts one. The first keydown that is not a lone modifier becomes the binding and ends the recording; an invalid one says so and
// keeps recording. Tab alone still moves the focus, and Escape, with or without modifiers, cancels the recording and leaves the focus on
// the chip (#481). Every key it takes is stopped here, and data-shortcut-recording tells the listeners that run before it (isRecording) to
// skip it.
function KeyField({ def, binding, onRecord }: KeyFieldProps) {
  const [recording, setRecording] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const mac = isMac();
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const key = event.nativeEvent;
    const plainTab = key.key === 'Tab' && !key.shiftKey && !key.ctrlKey && !key.altKey && !key.metaKey;
    if (!recording || plainTab) return;
    event.preventDefault();
    event.stopPropagation();
    if (key.key === 'Escape') { // the keyboard's way out (#481): nothing recorded, and no panel or Settings closes on it
      setRecording(false);
      setInvalid(false);
      return;
    }
    if (MODIFIER_KEYS.includes(key.key)) return;
    const next = bindingFromEvent(key, mac);
    setInvalid(next === undefined);
    if (next === undefined) return;
    setRecording(false);
    onRecord(next);
  }
  const shown = binding === null ? t('shortcuts.disabled') : displayBinding(binding, mac);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button" aria-label={t('shortcuts.record', { name: t(def.label) })} data-shortcut-recording={recording ? '' : undefined}
        className="justify-self-start rounded-md border border-input bg-background px-2.5 py-1 font-mono text-xs tracking-widest"
        onClick={() => setRecording(true)} onBlur={() => { setRecording(false); setInvalid(false); }} onKeyDown={onKeyDown}
      >
        {recording ? t('shortcuts.recording') : shown}
      </button>
      {invalid && <p className="text-destructive text-xs">{t('shortcuts.invalid')}</p>}
    </div>
  );
}

// The same four columns as a live row, so the keys line up (#513)
const ROW_GRID = 'm-0 grid grid-cols-[minmax(0,1fr)_10rem_auto_2.5rem] items-center gap-3 border-0 border-b px-5 py-2 last:border-b-0';

// A row whose keys cannot change here (#585): a fixed key, or a soon shortcut's planned key. Its name (with "(soon)" while the operation does
// not exist yet) and its keys; no record, reset or off. A soon row is muted whole, so its key reads as reserved, not live.
function StaticRow({ name, anchor, keys, isSoon }: { name: string; anchor: string; keys: string; isSoon: boolean }) {
  return (
    <fieldset id={anchor} aria-label={name} className={`${ROW_GRID} ${isSoon ? 'text-muted-foreground' : ''}`}>
      <span className="text-sm">{isSoon ? `${name} ${t('shortcuts.soon')}` : name}</span>
      <span className="justify-self-start px-2.5 py-1 font-mono text-xs tracking-widest">{keys}</span>
      <span />
      <span />
    </fieldset>
  );
}

interface ShortcutRowProps { def: ShortcutDef; binding: string | null; onSet(next: string | null | undefined): void }

// One shortcut (#513): its name (+ warning line), the key chip, restaurar (only while changed) and × (only while on).
function ShortcutRow({ def, binding, onSet }: ShortcutRowProps) {
  const name = t(def.label);
  const warns = binding !== null && def.inTerminal && takesTerminalKey(binding, isMac());
  return (
    <fieldset id={settingAnchor(def.label)} aria-label={name} className={ROW_GRID}>
      <div className="flex flex-col">
        <span className="text-sm">{name}</span>
        {warns && <span className="text-muted-foreground text-xs">{t('shortcuts.terminalWarning')}</span>}
      </div>
      <KeyField def={def} binding={binding} onRecord={onSet} />
      {binding !== defaultBinding(def, isMac()) ? <Button type="button" variant="ghost" size="sm" onClick={() => onSet(undefined)}>{t('shortcuts.reset')}</Button> : <span />}
      {binding !== null ? <Button type="button" variant="ghost" size="icon-sm" aria-label={t('shortcuts.off')} onClick={() => onSet(null)}><XIcon /></Button> : <span />}
    </fieldset>
  );
}

const SCOPE_KEY: Record<ShortcutScope, MessageKey> = {
  global: 'shortcuts.scope.global', activities: 'shortcuts.scope.activities', files: 'shortcuts.scope.files', flow: 'shortcuts.scope.flow', plugins: 'shortcuts.scope.plugins', benchmark: 'shortcuts.scope.benchmark', dialogs: 'shortcuts.scope.dialogs', settings: 'shortcuts.scope.settings',
};

/** Settings › atalhos (#513, #585): one flush SettingsGroup per scope with every row of the map in its order, a live shortcut recordable, a
 * soon one and a fixed key read only, plus restaurar todos above them. Like every Settings field it applies on Save: the main window at once, an
 * open terminal window the next time it opens. */
export function ShortcutsTab({ shortcuts, onChange }: ShortcutsTabProps) {
  const mac = isMac();
  const bindings = effectiveBindings(shortcuts, mac);
  const rowOf = (row: ShortcutDef | FixedShortcut): ReactNode => {
    if ('keys' in row) return <StaticRow key={`fixed:${row.id}`} name={t(row.label)} anchor={settingAnchor(row.label)} keys={displayKeys(fixedKeys(row, mac), mac)} isSoon={row.soon === true} />;
    if (row.soon) return <StaticRow key={row.id} name={t(row.label)} anchor={settingAnchor(row.label)} keys={displayBinding(defaultBinding(row, mac) ?? '', mac)} isSoon />;
    return <ShortcutRow key={row.id} def={row} binding={bindings[row.id]} onSet={(next) => onChange(withBinding(shortcuts, row.id, next, mac))} />;
  };
  return (
    <div className="flex flex-col gap-4">
      <Button type="button" variant="ghost" size="sm" className="self-end" disabled={Object.keys(shortcuts).length === 0} onClick={() => onChange({})}>
        {t('shortcuts.resetAll')}
      </Button>
      {SHORTCUT_SCOPES.map((scope) => (
        <SettingsGroup key={scope} title={SCOPE_KEY[scope]} flush>{SHORTCUT_MAP.filter((row) => row.scope === scope).map(rowOf)}</SettingsGroup>
      ))}
    </div>
  );
}

/** Settings › shortcuts' entries of the Settings search (#689): each scope's card and every row of the map under it. */
export function searchEntries(): SettingEntry[] {
  return SHORTCUT_SCOPES.flatMap((scope) => cardEntries('shortcuts', SCOPE_KEY[scope], SHORTCUT_MAP.filter((r) => r.scope === scope).map((r) => r.label)));
}
