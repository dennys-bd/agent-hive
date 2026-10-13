import { COLUMNS, CommandsEditor } from '@/components/settings/CommandsEditor';
import { WorkspacesEditor } from '@/components/settings/WorkspacesEditor';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import type { SettingsDraft } from '@/lib/settings-form';
import { cardEntries, contextEntries, named, type SettingEntry, settingAnchor } from '@/lib/settings-search';
import type { State } from '../../../types';

interface WorkspacesSectionProps { draft: SettingsDraft; state?: State; savedNames: readonly string[]; onChange(patch: Partial<SettingsDraft>): void; onCapSaved(workspace: string, cap: number): void }

// Settings › workspaces (#510, #511): one card per workspace (folder, setup, env), then the Comb's commands, each enabled in some of them.
// A removed workspace only leaves the workspaces: the commands keep its id, and toSettingsBody drops it. onCapSaved (#115): a memory dialog's save.
export function WorkspacesSection({ draft, state, savedNames, onChange, onCapSaved }: WorkspacesSectionProps) {
  return (
    <>
      <WorkspacesEditor workspaces={draft.workspaces} savedNames={savedNames} state={state} onChange={(workspaces) => onChange({ workspaces })} onCapSaved={onCapSaved} />
      <SettingsGroup title="settings.group.commands" hint="settings.commands.hint"><CommandsEditor draft={draft} onChange={onChange} /></SettingsGroup>
    </>
  );
}

/** One workspace's entries (#689): the card itself, its fields under the conditions its card renders them, and the two script timeouts. */
function workspaceEntries(row: SettingsDraft['workspaces'][number], i: number): SettingEntry[] {
  const view = { section: 'workspaces' } as const;
  const name = named(row.name, { key: 'settings.workspaces.card', vars: { n: i + 1 } });
  const path = ['settings.section.workspaces', name] as const;
  const labels = [
    'settings.workspaces.color', 'settings.workspaces.name', 'settings.workspaces.path', 'settings.fork.group', 'settings.fork.isFork',
    ...(row.fork ? (['settings.fork.remote', 'settings.fork.pr'] as const) : []),
    ...(row.fork && row.fork.pr !== 'original' ? (['settings.fork.sync'] as const) : []),
    'settings.workspaces.setup', 'settings.workspaces.teardown', 'settings.env.group', 'settings.conventions.group', 'settings.memory.group',
  ] as const;
  const timeouts = (['setup', 'teardown'] as const).map((script): SettingEntry => ({
    label: 'settings.workspaces.stepTimeout', path: [...path, `settings.workspaces.${script}`], view, anchor: settingAnchor('settings.workspaces.stepTimeout', `${row.id}-${script}`),
  }));
  return [{ label: name, path: path.slice(0, 1), view, anchor: settingAnchor('settings.workspaces', row.id) }, ...contextEntries(labels, view, path, row.id), ...timeouts];
}

/** Settings › workspaces' entries of the Settings search (#689): each workspace's card, then the commands card and its columns. */
export function searchEntries(draft: SettingsDraft): SettingEntry[] {
  return [
    ...draft.workspaces.flatMap(workspaceEntries),
    ...cardEntries('workspaces', 'settings.group.commands', COLUMNS.map((col) => `settings.commands.col.${col}` as const)),
  ];
}
