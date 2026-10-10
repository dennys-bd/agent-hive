import { CommandsEditor } from '@/components/settings/CommandsEditor';
import { WorkspacesEditor } from '@/components/settings/WorkspacesEditor';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import type { SettingsDraft } from '@/lib/settings-form';
import type { State } from '../../../types';

// Settings › workspaces (#510, #511): one card per workspace (folder, setup, env), then the Comb's commands, each enabled in some of them.
// A removed workspace only leaves the workspaces: the commands keep its id, and toSettingsBody drops it.
export function WorkspacesSection({ draft, state, savedNames, onChange }: { draft: SettingsDraft; state?: State; savedNames: readonly string[]; onChange(patch: Partial<SettingsDraft>): void }) {
  return (
    <>
      <WorkspacesEditor workspaces={draft.workspaces} savedNames={savedNames} state={state} onChange={(workspaces) => onChange({ workspaces })} />
      <SettingsGroup title="settings.group.commands" hint="settings.commands.hint"><CommandsEditor draft={draft} onChange={onChange} /></SettingsGroup>
    </>
  );
}
