import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CatalogueItem } from '../../../types';
import { DialogBase } from '@/components/DialogBase';
import { STATE_LOOK, StateDot } from '@/components/plugins/marks';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import type { ItemEditor } from '@/hooks/use-item-editor';
import { type MessageKey, t } from '@/i18n';
import { assignableWorkspaces, originalLabel, originalName, type VersionRow, versionInUse, versionRows } from '@/lib/plugins';

export interface VersionMenuProps { item: CatalogueItem; editor: ItemEditor; workspaces: readonly string[]; className?: string }
type Naming = 'new' | 'rename';
const MUTED = 'text-muted-foreground text-xs';

// A version's row (decisions 4–7): the check on the open one, the name, its state as a dot and its word (#492), the workspaces on it, the sub-line
function RowItem({ row, isOpen, onOpen }: { row: VersionRow; isOpen: boolean; onOpen(): void }) {
  const { state } = row;
  return (
    <DropdownMenuCheckboxItem checked={isOpen} onSelect={onOpen} className="items-start">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-sm">{row.label}</span>
          {state && <span className={`flex items-center gap-1.5 ${MUTED}`}><StateDot state={state} isDecorative />{t(STATE_LOOK[state].label)}</span>}
          <span className="ml-auto flex shrink-0 gap-2">
            {row.workspaces.map((w) => <span key={w} className={`flex items-center gap-1 ${MUTED}`}><WorkspaceSquare name={w} />{w}</span>)}
          </span>
        </span>
        {row.sub && <span className={MUTED}>{row.sub}</span>}
      </span>
    </DropdownMenuCheckboxItem>
  );
}

interface UseInProps { item: CatalogueItem; editor: ItemEditor; workspaces: readonly string[]; onRefused(key: MessageKey | undefined): void }

// "use in…" (decision 12): each workspace with the version it runs today, greyed; the ones already on the open version checked and disabled
function UseInSub({ item, editor, workspaces, onRefused }: UseInProps) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t('plugins.version.useIn')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {assignableWorkspaces(item, workspaces).map((w) => {
          const inUse = versionInUse(item, w);
          const isOn = inUse === editor.version;
          return (
            <DropdownMenuCheckboxItem key={w} checked={isOn} disabled={isOn} onSelect={() => void editor.assignTo(w).then(onRefused)}>
              <WorkspaceSquare name={w} />{w}
              {inUse !== undefined && <span className={`ml-auto pl-3 font-mono ${MUTED}`}>{inUse ?? originalName(item)}</span>}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

interface NameDialogProps { title: string; confirmLabel: string; initial: string; onName(name: string): Promise<MessageKey | undefined>; onClose(): void }

// The name of "new version from…" and "rename" (decisions 11, 13): Enter confirms (DialogBase); a refusal shows inline and keeps it open
function NameDialog({ title, confirmLabel, initial, onName, onClose }: NameDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  const [refused, setRefused] = useState<MessageKey>();
  useEffect(() => {
    input.current?.select(); // opens to be typed in, a rename's name selected; autoFocus is refused by the lint
  }, []);
  const confirm = async (): Promise<void> => {
    const refusal = await onName(name.trim());
    if (refusal === undefined) return;
    setRefused(refusal);
    throw new Error(refusal); // keeps the dialog open (DialogBase)
  };
  return (
    <DialogBase
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={title} initialFocus="none" error={refused && t(refused)}
      primary={{ label: confirmLabel, onConfirm: confirm, disabled: name.trim() === '' }}
    >
      <Input
        ref={input} aria-label={t('plugins.version.name')} value={name} aria-invalid={refused !== undefined} className="font-mono"
        onChange={(event) => { setName(event.target.value); setRefused(undefined); }}
      />
    </DialogBase>
  );
}

/** The item head's version selector (#320, handoff 11j): the open version's name, the menu of its versions and the original, and the actions
 * on the open one. A row opens that version in the editor; the state chip stays the way into an update (decision 14). */
export function VersionMenu({ item, editor, workspaces, className = '' }: VersionMenuProps) {
  const [naming, setNaming] = useState<Naming>();
  const [refused, setRefused] = useState<MessageKey>();
  const { version } = editor;
  const openName = version ?? originalName(item);
  const close = (): void => setNaming(undefined);
  return (
    <>
      <DropdownMenu onOpenChange={(isOpen) => { if (isOpen) setRefused(undefined); }}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="xs" variant="outline" title={t('plugins.version.menu')} className={`font-normal ${className}`}>
            {version ?? originalLabel(item)}<ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[430px]">
          <DropdownMenuLabel className={`font-normal ${MUTED}`}>{t('plugins.version.header', { name: item.name })}</DropdownMenuLabel>
          {versionRows(item).map((row) => <RowItem key={row.version ?? ''} row={row} isOpen={row.version === version} onOpen={() => editor.openVersion(row.version)} />)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNaming('new')}>{t('plugins.version.new', { name: openName })}</DropdownMenuItem>
          <UseInSub item={item} editor={editor} workspaces={workspaces} onRefused={setRefused} />
          {version !== null && <DropdownMenuItem onSelect={() => setNaming('rename')}>{t('plugins.version.rename')}</DropdownMenuItem>}
          <p className={`px-2 pt-1.5 pb-1 ${MUTED}`}>{t('plugins.version.footer')}</p>
        </DropdownMenuContent>
      </DropdownMenu>
      {refused && <span role="alert" className="font-normal text-destructive text-xs">{t(refused)}</span>}
      {naming === 'new' && (
        <NameDialog title={t('plugins.version.newTitle', { name: openName })} confirmLabel={t('plugins.version.create')} initial="" onName={editor.createVersion} onClose={close} />
      )}
      {naming === 'rename' && version !== null && (
        <NameDialog title={t('plugins.version.renameTitle', { name: version })} confirmLabel={t('plugins.version.rename')} initial={version} onName={editor.renameVersion} onClose={close} />
      )}
    </>
  );
}
