import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { isMac, savedShortcuts } from '@/lib/shortcut-bindings';
import { type MapSection, shortcutMapSections } from '@/lib/shortcut-map';

/** onEditShortcuts: the footer's way to Settings › atalhos; absent (a harness), no link. */
export interface ShortcutMapDialogProps { open: boolean; onClose(): void; onEditShortcuts?(): void }

// One scope: its title as Settings › atalhos names it, then each row's name and its keys in the shortcut text style. No colour: no status here
function MapScope({ section }: { section: MapSection }) {
  const title = t(`shortcuts.scope.${section.scope}`);
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <dl className="m-0 flex flex-col">
        {section.rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 py-1">
            <dt className="text-sm">{t(row.label)}</dt>
            <dd className="m-0 shrink-0 font-mono text-xs tracking-widest">{row.keys}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// Radix gives the focus back to a trigger only, and the map has none: it goes back to what held it when the map opened, unless something
// took it meanwhile (Settings, opened by the link)
function restoreFocus(before: Element | null): void {
  const isFree = document.activeElement === null || document.activeElement === document.body;
  if (isFree && before instanceof HTMLElement && before.isConnected) before.focus();
}

/** The shortcut map (#639): read only, the keys that work now by scope with the user's changes applied; its rows run nothing. Escape, a
 * click outside or its own key close it. */
export function ShortcutMapDialog({ open, onClose, onEditShortcuts }: ShortcutMapDialogProps) {
  const before = useRef<Element | null>(null);
  const sections = shortcutMapSections(savedShortcuts(), isMac()); // read at each render, so a Settings save shows on the next open
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="max-h-[calc(100vh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto]" showCloseButton={false} aria-describedby={undefined}
        // still what held the focus: Radix moves it into the dialog only after this event
        onOpenAutoFocus={() => { before.current = document.activeElement; }}
        onCloseAutoFocus={(e) => { e.preventDefault(); restoreFocus(before.current); }}
      >
        <DialogTitle>{t('shortcutMap.title')}</DialogTitle>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {sections.map((section) => <MapScope key={section.scope} section={section} />)}
        </div>
        {onEditShortcuts && (
          <DialogFooter>
            <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={onEditShortcuts}>{t('shortcutMap.edit')}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
