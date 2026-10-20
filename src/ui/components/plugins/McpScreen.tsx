import { useState } from 'react';
import { McpServerForm } from '@/components/plugins/McpServerForm';
import { McpServerRow } from '@/components/plugins/McpServerRow';
import { McpToolRow } from '@/components/plugins/McpToolRow';
import { Button } from '@/components/ui/button';
import { type Mcp, type McpServerRow as Row, type McpTool, type ServerDraft, useMcp, VALUE_NOT_SAVED } from '@/hooks/use-mcp';
import type { Plugins } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';

const SECTION = 'flex min-w-0 flex-col gap-2';
const CAPTION = 'flex h-6 items-center justify-between text-muted-foreground text-xs';
const TABLE = 'flex flex-col rounded-lg border';

function ToolsSection({ tools, onSwitch }: { tools: readonly McpTool[]; onSwitch(name: string, on: boolean): void }) {
  return (
    <section aria-label={t('plugins.mcp.hiveTools')} className={SECTION}>
      <div className={CAPTION}>{t('plugins.mcp.hiveTools')}</div>
      <ul className={TABLE}>{tools.map((tool) => <McpToolRow key={tool.name} tool={tool} onSwitch={(on) => onSwitch(tool.name, on)} />)}</ul>
    </section>
  );
}

interface ServersProps { mcp: Mcp; servers: readonly Row[]; plugins: Plugins; workspaces: readonly string[] }

// The servers and the form panel under them: "+ server" (here or in the head, through isCreating) opens a new one, a row's name its edit
function ServersSection({ mcp, servers, plugins, workspaces }: ServersProps) {
  const [editing, setEditing] = useState<string>();
  const row = plugins.isCreating ? undefined : servers.find((server) => server.name === editing);
  const close = (): void => {
    setEditing(undefined);
    plugins.setCreating(false);
  };
  const edit = (name: string): void => {
    plugins.setCreating(false);
    setEditing(name);
  };
  const save = async (draft: ServerDraft): Promise<MessageKey | undefined> => {
    const refused = await mcp.saveServer(row?.name, draft);
    if (refused !== undefined && refused !== VALUE_NOT_SAVED) return refused;
    close(); // the definition saved: a value the route did not store shows on the screen's error line, and a retry is an edit
    return undefined;
  };
  const remove = async (): Promise<MessageKey | undefined> => {
    const refused = row === undefined ? undefined : await mcp.removeServer(row.name);
    if (refused === undefined) close();
    return refused;
  };
  return (
    <section aria-label={t('plugins.mcp.servers')} className={SECTION}>
      <div className={CAPTION}>
        <span>{t('plugins.mcp.servers')}</span>
        <Button type="button" size="xs" variant="ghost" onClick={() => plugins.setCreating(true)}>{t('plugins.mcp.addServer')}</Button>
      </div>
      {servers.length > 0 && (
        <ul className={TABLE}>
          {servers.map((server) => (
            <McpServerRow key={server.name} server={server} workspaces={workspaces} onEdit={() => edit(server.name)} onChange={(next) => void mcp.setServer(server.name, next)} />
          ))}
        </ul>
      )}
      {(plugins.isCreating || row !== undefined) && (
        <McpServerForm key={row?.name ?? ''} server={row} workspaces={workspaces} onSave={save} onRemove={remove} onCancel={close} />
      )}
    </section>
  );
}

/** Screen 11f (#334): the Hive's tools (a lock and its reason, or a switch) and the external servers (target, scope, state, switch) with the
 * form panel; every write through #333's routes. The first read shows a loading line; a later read keeps the last answer on screen. */
export function McpScreen({ plugins, workspaces }: { plugins: Plugins; workspaces: readonly string[] }) {
  const mcp = useMcp();
  const { read } = mcp;
  return (
    <section aria-label={t('plugins.section.mcp')} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      {read === undefined && !mcp.hasFailed && <p className="text-muted-foreground text-xs">{t('plugins.mcp.loading')}</p>}
      {/* a failed re-read keeps the last answer on screen, so the line says it is stale */}
      {mcp.hasFailed && (
        <p role="alert" className="flex items-center gap-2 text-destructive text-xs">
          {t('plugins.mcp.readFailed')}
          <Button type="button" size="sm" variant="outline" onClick={() => void mcp.reload()}>{t('task.retry')}</Button>
        </p>
      )}
      {mcp.error && <p role="alert" className="text-destructive text-xs">{t(mcp.error)}</p>}
      {read && <ToolsSection tools={read.tools} onSwitch={(name, on) => void mcp.setTool(name, on)} />}
      {read && <ServersSection mcp={mcp} servers={read.servers} plugins={plugins} workspaces={workspaces} />}
    </section>
  );
}
