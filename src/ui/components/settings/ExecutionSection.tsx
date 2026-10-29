import { AgentsCard } from '@/components/settings/AgentsCard';
import { CHILD, FIELD, FIELD_LABEL, FIELD_ROW } from '@/components/settings/field-row';
import { SESSION_SYNONYMS, SessionsTable } from '@/components/settings/SessionsTable';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { SettingSwitch } from '@/components/settings/SettingSwitch';
import { WorkspaceBases } from '@/components/settings/WorkspaceBases';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { cardEntries, type SettingEntry, settingAnchor, settingEntry } from '@/lib/settings-search';
import { agentName } from '../../../agents';
import { AGENT_IDS, type AgentAvailability, type DeleteActivityScope } from '../../../types';

interface ExecutionSectionProps { draft: SettingsDraft; agents: readonly AgentAvailability[]; launchWorkspace?: string; onChange(patch: Partial<SettingsDraft>): void; onOpenFlow(): void }

// Literal text, never through t(): its placeholder regex would read {id} as a placeholder.
const BRANCH_TOKENS = ['{id}', '{title}', '{slug}'] as const;

// A child switch hangs under its parent, indented behind a rule, as in the design.

interface DeleteActivitySwitchesProps { scope: DeleteActivityScope; onChange(scope: DeleteActivityScope): void }

// What deleting an activity forgets besides its worktree, branch and terminals, which always go (#236, #573). The transcripts need the
// sessions: greyed while the sessions are off, and turned off with them. The last one says which tasks a delete-activity stage takes (#496).
function DeleteActivitySwitches({ scope, onChange }: DeleteActivitySwitchesProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium text-sm sr-only">{t('settings.deleteActivity')}</legend>
      <SettingSwitch
        id="settings-delete-activity-session" label="settings.deleteActivity.session" hint="settings.deleteActivity.session.hint"
        checked={scope.session} onCheckedChange={(session) => onChange({ ...scope, session, transcripts: session && scope.transcripts })}
      />
      <div className={CHILD}>
        <SettingSwitch
          id="settings-delete-activity-transcripts" label="settings.deleteActivity.transcripts" hint={scope.session ? 'settings.deleteActivity.transcripts.hint' : 'settings.deleteActivity.transcripts.off'}
          checked={scope.transcripts} disabled={!scope.session} onCheckedChange={(transcripts) => onChange({ ...scope, transcripts })}
        />
      </div>
      <SettingSwitch
        id="settings-delete-activity-non-auto" label="settings.deleteActivity.nonAutoTasks" hint="settings.deleteActivity.nonAutoTasks.hint"
        checked={scope.nonAutoTasks} onCheckedChange={(nonAutoTasks) => onChange({ ...scope, nonAutoTasks })}
      />
    </fieldset>
  );
}

// "sessões e espera": what closing a tab does (#614, #696), the sleep notices (#672), the idle (#233) and approval (#268) windows and the
// rate-limit wait (#805), as a table by situation (#778).
function SessionsGroup({ draft, onChange }: Pick<ExecutionSectionProps, 'draft' | 'onChange'>) {
  return (
    <SettingsGroup title="settings.group.waiting" hint="settings.sessions.hint">
      <SessionsTable draft={draft} onChange={onChange} />
    </SettingsGroup>
  );
}

// Settings › execution (#510): how each worker starts (#516), waits for you and what goes when its activity is deleted.
export function ExecutionSection({ draft, agents, launchWorkspace, onChange, onOpenFlow }: ExecutionSectionProps) {
  return (
    <>
      <AgentsCard draft={draft} agents={agents} launchWorkspace={launchWorkspace} onChange={onChange} onOpenFlow={onOpenFlow} />
      <SessionsGroup draft={draft} onChange={onChange} />
      <SettingsGroup title="settings.group.branches" hint="settings.group.branches.hint">
        <div className={FIELD_ROW}>
          <div id={settingAnchor('settings.branch')} className={FIELD}>
            <Label htmlFor="settings-branch" className={FIELD_LABEL}>{t('settings.branch')}</Label>
            <Input id="settings-branch" defaultValue={draft.branch} placeholder="hive/{id}-{title}" onChange={(e) => onChange({ branch: e.target.value })} />
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span>{t('settings.branch.insert')}</span>
              {BRANCH_TOKENS.map((token) => <Badge key={token} variant="outline" className="font-mono">{token}</Badge>)}
            </div>
          </div>
          <div id={settingAnchor('settings.baseBranch')} className={FIELD}>
            <Label htmlFor="settings-base-branch" className={FIELD_LABEL}>{t('settings.baseBranch')}</Label>
            <Input id="settings-base-branch" defaultValue={draft.baseBranch} placeholder={t('settings.baseBranch.auto')} onChange={(e) => onChange({ baseBranch: e.target.value })} />
            <p className="text-muted-foreground text-xs">{t('settings.baseBranch.hint')}</p>
          </div>
        </div>
        <WorkspaceBases draft={draft} onChange={onChange} /> {/* #854 */}
      </SettingsGroup>
      <SettingsGroup title="settings.deleteActivity" hint="settings.deleteActivity.hint">
        <DeleteActivitySwitches scope={draft.deleteActivity} onChange={(deleteActivity) => onChange({ deleteActivity })} />
      </SettingsGroup>
    </>
  );
}

/** Settings › execution's entries of the Settings search (#689). */
export function searchEntries(): SettingEntry[] {
  return [
    settingEntry('settings.agents', 'execution'),
    ...AGENT_IDS.flatMap((agent) => (['settings.agents.model.of', 'settings.agentArgs', 'settings.agents.enabled.of'] as const).map((key): SettingEntry => ({
      label: { key, vars: { agent: agentName(agent) } }, path: ['settings.section.execution', 'settings.agents'],
      view: { section: 'execution' }, anchor: settingAnchor(key, agent),
    }))),
    settingEntry('settings.group.waiting', 'execution'),
    ...SESSION_SYNONYMS.map(([row, keys]) => settingEntry(`settings.sessions.${row}`, 'execution', 'settings.group.waiting', keys)),
    ...cardEntries('execution', 'settings.group.branches', ['settings.branch', 'settings.baseBranch', 'settings.baseBranch.perWorkspace']),
    ...cardEntries('execution', 'settings.deleteActivity', ['settings.deleteActivity.session', 'settings.deleteActivity.transcripts', 'settings.deleteActivity.nonAutoTasks']),
  ];
}
