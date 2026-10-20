import type { ExternalMcpServer } from '../../../types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { McpServerRow as Row } from '@/hooks/use-mcp';
import { type MessageKey, t } from '@/i18n';

// The handoff's columns: name, command or URL, scope, state, switch
const COLUMNS = 'grid grid-cols-[160px_minmax(0,1fr)_200px_120px_40px] items-center gap-4';
const ALL = '*'; // "all workspaces": Radix refuses '' as an item's value, and no workspace may be named `*` (WORKSPACE_NAME)
// Colour only for status: connected green, not responding red; off and checking stay neutral
const STATE_LOOK: Record<Row['state'], { label: MessageKey; dot: string; text: string }> = {
  connected: { label: 'plugins.mcp.state.connected', dot: 'bg-working', text: 'text-working' },
  no_answer: { label: 'plugins.mcp.state.no_answer', dot: 'bg-destructive', text: 'text-destructive' },
  off: { label: 'plugins.mcp.state.off', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  checking: { label: 'plugins.mcp.state.checking', dot: 'border border-muted-foreground', text: 'text-muted-foreground' },
};

/** A server's target on one line: the command and its args joined by spaces, or the URL. */
export const targetOf = (server: ExternalMcpServer): string => ('url' in server ? server.url : [server.command, ...server.args].join(' '));

interface ScopeSelectProps { scope: string | null; workspaces: readonly string[]; label: string; onChange(scope: string | null): void }

/** A server's scope, in its row and in the form: every workspace (null) or one. A workspace no longer configured stays listed while it is the scope. */
export function ScopeSelect({ scope, workspaces, label, onChange }: ScopeSelectProps) {
  const choices = scope === null || workspaces.includes(scope) ? workspaces : [...workspaces, scope];
  return (
    <Select value={scope ?? ALL} onValueChange={(value) => onChange(value === ALL ? null : value)}>
      <SelectTrigger size="sm" aria-label={label} className="h-7 justify-self-start text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('plugins.list.allWorkspaces')}</SelectItem>
        {choices.map((workspace) => <SelectItem key={workspace} value={workspace}>{t('plugins.mcp.only', { workspace })}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

interface McpServerRowProps { server: Row; workspaces: readonly string[]; onEdit(): void; onChange(server: ExternalMcpServer): void }

/** One external server (#334). Its name and target are the button that opens it in the form; the scope and the switch sit beside that
 * button, since a button cannot hold another control. */
export function McpServerRow({ server, workspaces, onEdit, onChange }: McpServerRowProps) {
  const look = STATE_LOOK[server.state];
  return (
    <li className={`${COLUMNS} border-b px-3.5 py-2 text-[13px] last:border-b-0`}>
      <button
        type="button" aria-label={t('plugins.mcp.edit', { name: server.name })} onClick={onEdit}
        className="col-span-2 grid grid-cols-subgrid items-center rounded-md py-0.5 text-left hover:bg-accent/60"
      >
        <span className="truncate font-medium">{server.name}</span>
        <span className="truncate font-mono text-muted-foreground text-xs">{targetOf(server)}</span>
      </button>
      <ScopeSelect scope={server.workspace} workspaces={workspaces} label={t('plugins.mcp.scopeOf', { name: server.name })} onChange={(workspace) => onChange({ ...server, workspace })} />
      <span className={`flex items-center gap-1.5 text-xs ${look.text}`}><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${look.dot}`} />{t(look.label)}</span>
      <span className="flex justify-end"><Switch checked={server.on} aria-label={server.name} onCheckedChange={(on) => onChange({ ...server, on })} /></span>
    </li>
  );
}
