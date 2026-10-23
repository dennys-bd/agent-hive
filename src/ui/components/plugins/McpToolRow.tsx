import { LockIcon } from 'lucide-react';
import type { LOCKED_TOOLS, OptionalTool } from '../../../types';
import { Switch } from '@/components/ui/switch';
import type { McpTool } from '@/hooks/use-mcp';
import { type MessageKey, t } from '@/i18n';

type LockedTool = (typeof LOCKED_TOOLS)[number];

// The handoff's columns: the name, what the tool does, why it is locked or what turning it off drops, the lock or the switch
const COLUMNS = 'grid grid-cols-[160px_minmax(0,1fr)_220px_40px] items-center gap-4';
// Copy keyed by tool name, since the route answers name, locked and on only; a Record per list makes tsc ask for a new tool's copy
const DESCRIPTION: Record<LockedTool | OptionalTool, MessageKey> = {
  hive_done: 'plugins.mcp.tool.hive_done', hive_ask: 'plugins.mcp.tool.hive_ask', hive_stop: 'plugins.mcp.tool.hive_stop',
  hive_pr: 'plugins.mcp.tool.hive_pr', hive_reply: 'plugins.mcp.tool.hive_reply', hive_conventions: 'plugins.mcp.tool.hive_conventions',
  hive_remember: 'plugins.mcp.tool.hive_remember', hive_applied: 'plugins.mcp.tool.hive_applied', hive_create_task: 'plugins.mcp.tool.hive_create_task', hive_task: 'plugins.mcp.tool.hive_task',
  benchmark_list: 'plugins.mcp.tool.benchmark_list', benchmark_get: 'plugins.mcp.tool.benchmark_get', benchmark_draft: 'plugins.mcp.tool.benchmark_draft',
};
const LOCK_REASON: Record<LockedTool, MessageKey> = {
  hive_done: 'plugins.mcp.locked.hive_done', hive_ask: 'plugins.mcp.locked.hive_ask', hive_stop: 'plugins.mcp.locked.hive_stop',
  hive_pr: 'plugins.mcp.locked.hive_pr', hive_reply: 'plugins.mcp.locked.hive_reply', hive_conventions: 'plugins.mcp.locked.hive_conventions',
};
// What a tool turned off drops: a fixed count per tool, the passages src/protocol.ts gives it (REMEMBER_LINE, TASK_LINE, the memory section);
// hive_create_task and the benchmark's three have none. #336 makes the protocol drop them
const EFFECT: Record<OptionalTool, MessageKey> = {
  hive_remember: 'plugins.mcp.effect.passage', hive_applied: 'plugins.mcp.effect.passage', hive_create_task: 'plugins.mcp.effect.off', hive_task: 'plugins.mcp.effect.passage',
  benchmark_list: 'plugins.mcp.effect.off', benchmark_get: 'plugins.mcp.effect.off', benchmark_draft: 'plugins.mcp.effect.off',
};

// A tool the UI has no copy for yet shows its name alone; hasOwn keeps a name like `constructor` off the prototype
function copyOf(keys: Readonly<Record<string, MessageKey>>, name: string): string {
  const key = Object.hasOwn(keys, name) ? keys[name] : undefined;
  return key === undefined ? '' : t(key);
}

function noteOf(tool: McpTool): string {
  if (tool.locked) return copyOf(LOCK_REASON, tool.name);
  return tool.on ? '' : copyOf(EFFECT, tool.name);
}

/** One of the Hive's tools (#334): a locked one carries a lock whose tooltip and name are its reason, never a switch; an optional one its switch. */
export function McpToolRow({ tool, onSwitch }: { tool: McpTool; onSwitch(on: boolean): void }) {
  const reason = copyOf(LOCK_REASON, tool.name);
  return (
    <li className={`${COLUMNS} border-b px-3.5 py-2.5 text-[13px] last:border-b-0`}>
      <span className="truncate font-medium font-mono">{tool.name}</span>
      <span className="truncate text-muted-foreground">{copyOf(DESCRIPTION, tool.name)}</span>
      <span className="text-muted-foreground text-xs">{noteOf(tool)}</span>
      <span className="flex justify-end">
        {tool.locked
          ? <span role="img" aria-label={reason} title={reason} className="text-muted-foreground"><LockIcon aria-hidden="true" className="size-3.5" /></span>
          : <Switch checked={tool.on} aria-label={tool.name} onCheckedChange={onSwitch} />}
      </span>
    </li>
  );
}
