import { PlusIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { deliveredName } from '../../../template';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type MessageKey, t } from '@/i18n';
import type { EditorMode } from '@/lib/template-view';

const MODES: readonly EditorMode[] = ['visual', 'text'];
const MODE_LABEL: Record<EditorMode, MessageKey> = { visual: 'plugins.mode.visual', text: 'plugins.mode.text' };

export interface FileTabsProps {
  files: readonly string[]; open: string; isDirty(path: string): boolean; onOpen(path: string): void;
  onAdd?(path: string): Promise<MessageKey | undefined>; // absent: no "+" (a specialist, the preview)
  mode?: EditorMode; onMode?(mode: EditorMode): void; // absent: no toggle (a file with no map, the preview)
  previewOf?: string; // the "view as" workspace (decision 26)
}

// The "+" field (decision 13), the shape of the shell's new-item field: Enter creates, Esc cancels, a refusal shows under it until typing
function NewFileField({ onAdd, onClose }: { onAdd(path: string): Promise<MessageKey | undefined>; onClose(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<MessageKey>();
  useEffect(() => {
    input.current?.focus(); // the field opens to be typed in; autoFocus is refused by the lint
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void onAdd(name.trim()).then((refused) => (refused === undefined ? onClose() : setError(refused)));
  };
  return (
    <span className="flex items-center gap-2">
      <Input
        ref={input} aria-label={t('plugins.file.name')} value={name} aria-invalid={error !== undefined} onKeyDown={onKeyDown}
        onChange={(event) => { setName(event.target.value); setError(undefined); }} className="h-6 w-40 font-mono text-xs"
      />
      {error && <span role="alert" className="text-destructive text-xs">{t(error)}</span>}
    </span>
  );
}

const labelOf = (path: string, open: string, previewOf?: string): string => {
  if (previewOf === undefined) return path;
  return path === open ? `${deliveredName(path)} · ${previewOf}` : deliveredName(path);
};

/** The skill's file tabs (#319, handoff 11b): the folder's files with the dirty dot, "+" and its name field, the visual | text toggle on the right. */
export function FileTabs({ files, open, isDirty, onOpen, onAdd, mode, onMode, previewOf }: FileTabsProps) {
  const [isAdding, setAdding] = useState(false);
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
      <div role="tablist" aria-label={t('plugins.file.tabs')} className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {files.map((path) => (
          <button
            key={path} type="button" role="tab" aria-selected={path === open} data-dirty={isDirty(path)} onClick={() => onOpen(path)}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-muted-foreground aria-selected:bg-accent aria-selected:text-foreground"
          >
            {labelOf(path, open, previewOf)}
            {isDirty(path) && <span title={t('plugins.file.unsaved')} className="size-1.5 rounded-full bg-foreground" />}
          </button>
        ))}
      </div>
      {onAdd && (isAdding
        ? <NewFileField onAdd={onAdd} onClose={() => setAdding(false)} />
        : <Button type="button" variant="ghost" size="icon" aria-label={t('plugins.file.new')} className="size-6" onClick={() => setAdding(true)}><PlusIcon /></Button>)}
      {mode && onMode && (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the toggle
        <div role="group" aria-label={t('plugins.mode.label')} className="ml-auto flex items-center rounded-md border p-0.5">
          {MODES.map((m) => (
            <button key={m} type="button" aria-pressed={m === mode} onClick={() => onMode(m)} className="rounded-sm px-2 py-0.5 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground">{t(MODE_LABEL[m])}</button>
          ))}
        </div>
      )}
    </div>
  );
}
