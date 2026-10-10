import { useEffect, useState } from 'react';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';
import { readView, writeView } from '@/lib/view-state';
import { workspaceColor } from '@/lib/workspace-color';

interface DialogProps { open: boolean; onClose(): void }
interface WorkspaceBranch { name: string; branch: string | null }

// Per viewer, like the dock's layout, in the view state (#484): the workspace ⌘T offers first, so ⌘T then ↵ opens there at once. A string
// reads as the last workspace, anything else as none.
export function readLastWorkspace(): string | undefined {
  const stored = readView('lastWorkspace');
  return typeof stored === 'string' ? stored : undefined;
}

export const rememberWorkspace = (name: string): void => writeView('lastWorkspace', name);

/** Each checkout's branch, read while `open` holds and again whenever `key` changes: the picker when it opens, the activities sidebar's local
 * entries (redesign 03). A failed read only leaves the rows without a branch: the pick still works. */
export function useBranches(open: boolean, key = ''): Record<string, string | null> {
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the trigger of a new read, not a value it uses
  useEffect(() => {
    if (!open) return;
    getJson<WorkspaceBranch[]>('/workspaces/branches')
      .then((rows) => setBranches(Object.fromEntries(rows.map((row) => [row.name, row.branch]))))
      .catch(() => setBranches({}));
  }, [open, key]);
  return branches;
}

interface WorkspacePickerProps extends DialogProps { workspaces: string[]; onPick(workspace: string): void }

/** The quick picker of ⌘T and terminal no local (redesign 08): one workspace per row with its colour, name and current branch, the last one
 * used selected, typing filtering the rows. */
export function WorkspacePicker({ open, workspaces, onPick, onClose }: WorkspacePickerProps) {
  // A workspace removed since keeps no row: cmdk would select nothing, so the first row takes the selection instead
  const branches = useBranches(open);
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false} aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t('picker.title')}</DialogTitle>
        <Command defaultValue={workspaces.find((name) => name === readLastWorkspace())} loop>
          <CommandInput placeholder={t('picker.placeholder')} />
          <CommandList>
            <CommandEmpty>{t('picker.empty')}</CommandEmpty>
            {workspaces.map((name) => (
              <CommandItem key={name} value={name} onSelect={() => onPick(name)}>
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: workspaceColor(name) }} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {branches[name] && <span className="truncate font-mono text-muted-foreground text-xs">{branches[name]}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
