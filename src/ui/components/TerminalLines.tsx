import { SquareTerminalIcon } from 'lucide-react';
import { act } from '@/components/actions';
import { wakeTerminal } from '@/components/sleeping-run';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { t } from '@/i18n';
import type { KeptTerminal } from '@/lib/activities';

const DESTRUCTIVE = 'text-destructive focus:text-destructive';

/** A terminal's line text (#696): terminal, or terminal N once its activity keeps several. */
export const terminalName = ({ n }: Pick<KeptTerminal, 'n'>): string => (n === undefined ? t('activities.menu.terminal') : `${t('activities.menu.terminal')} ${n}`);

/** A kept terminal's click (#696), on its sidebar line and its row on the activity's home (#759): a live one opens its tab; a sleeping one
 * wakes in its own id, then opens. */
export function openTerminal({ terminalId, asleep }: Pick<KeptTerminal, 'terminalId' | 'asleep'>, onOpen: (ptyId: string) => void): void {
  if (asleep) void wakeTerminal(terminalId).then((result) => { if (result?.ptyId !== undefined) onOpen(result.ptyId); });
  else onOpen(terminalId);
}

interface LineProps { terminal: KeptTerminal; isShown: boolean; onOpen(terminalId: string): void }

// One kept terminal (#696): a live one opens its tab; a sleeping one wakes, then opens, and its right-click forgets it
function TerminalLine({ terminal, isShown, onOpen }: LineProps) {
  const { terminalId, asleep } = terminal;
  const line = (
    <button
      type="button" aria-current={isShown ? 'true' : undefined} onClick={() => openTerminal(terminal, onOpen)}
      className={`flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-[3px] text-left text-xs ${isShown ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
    >
      <SquareTerminalIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{terminalName(terminal)}</span>
      {asleep && <span className="shrink-0 text-muted-foreground">{t('session.sleeping')}</span>}
    </button>
  );
  if (!asleep) return line;
  const forget = (): void => void act(`/terminals/${encodeURIComponent(terminalId)}/forget`);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{line}</ContextMenuTrigger>
      <ContextMenuContent className="w-[220px]"><ContextMenuItem className={DESTRUCTIVE} onSelect={forget}>{t('terminal.forget')}</ContextMenuItem></ContextMenuContent>
    </ContextMenu>
  );
}

/** An activity's kept terminals after its session lines (#696), on the same guide line, a task's and a local activity's alike. `shown` is the
 * run the center shows while this activity is the selected one. */
export function TerminalLines({ terminals, shown, onOpen }: { terminals: KeptTerminal[]; shown?: string; onOpen(terminalId: string): void }) {
  return terminals.map((terminal) => <TerminalLine key={terminal.terminalId} terminal={terminal} isShown={terminal.terminalId === shown} onOpen={onOpen} />);
}
