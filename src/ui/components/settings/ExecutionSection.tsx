import { AgentSelect } from '@/components/settings/AgentSelect';
import { CHILD, FIELD, FIELD_LABEL, FIELD_ROW } from '@/components/settings/field-row';
import { SESSION_SYNONYMS, SessionsTable } from '@/components/settings/SessionsTable';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { SettingSwitch } from '@/components/settings/SettingSwitch';
import { WorkspaceBases } from '@/components/settings/WorkspaceBases';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { cardEntries, type SettingEntry, settingAnchor, settingEntry } from '@/lib/settings-search';
import { agentName } from '../../../agents';
import { AGENT_IDS, type AgentAvailability, type DeleteActivityScope } from '../../../types';

interface ExecutionSectionProps { draft: SettingsDraft; agents: readonly AgentAvailability[]; onChange(patch: Partial<SettingsDraft>): void; onOpenFlow(): void }

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

// #516: the agent a stage runs when it picks none. One boot did not find stays selectable as saved, with a muted note: its runs are refused.
// #778: a low full-width band, the select beside its hint, since one select does not deserve a tall card. flush and a padded grid, so
// SettingsGroup gains no prop for it.
// #924: each agent's own arguments under the default agent, one per line, so a value with spaces stays one argument
function AgentArgsFields({ draft, onChange }: Pick<ExecutionSectionProps, 'draft' | 'onChange'>) {
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      {AGENT_IDS.map((agent) => (
        <div key={agent} id={settingAnchor('settings.agentArgs', agent)} className={FIELD}>
          <Label htmlFor={`settings-agent-args-${agent}`} className={FIELD_LABEL}>{t('settings.agentArgs', { agent: agentName(agent) })}</Label>
          <Textarea
            id={`settings-agent-args-${agent}`} rows={3} className="font-mono" value={draft.agentArgs[agent]}
            onChange={(e) => onChange({ agentArgs: { ...draft.agentArgs, [agent]: e.target.value } })}
          />
          <p className="text-muted-foreground text-xs">{t('settings.agentArgs.hint')}</p>
        </div>
      ))}
    </div>
  );
}

function DefaultAgentGroup({ draft, agents, onChange, onOpenFlow }: ExecutionSectionProps) {
  const missing = agents.some((a) => a.agent === draft.defaultAgent && !a.available);
  return (
    <SettingsGroup title="settings.defaultAgent" flush>
      <div className="grid grid-cols-[20rem_minmax(0,1fr)] items-center gap-3 px-5 py-4">
        <div>
          <Label htmlFor="settings-default-agent" className="sr-only">{t('settings.defaultAgent')}</Label>
          <AgentSelect id="settings-default-agent" value={draft.defaultAgent} agents={agents} onChange={(agent) => agent !== '' && onChange({ defaultAgent: agent })} />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            <span>{t('settings.defaultAgent.hint')}</span>{' '}
            <button type="button" className="text-review" onClick={onOpenFlow}>{t('settings.section.flow')}</button>
          </p>
          {missing && <p className="text-muted-foreground text-xs">{t('settings.defaultAgent.missing', { agent: draft.defaultAgent })}</p>}
        </div>
      </div>
      <AgentArgsFields draft={draft} onChange={onChange} />
    </SettingsGroup>
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
export function ExecutionSection({ draft, agents, onChange, onOpenFlow }: ExecutionSectionProps) {
  return (
    <>
      <DefaultAgentGroup draft={draft} agents={agents} onChange={onChange} onOpenFlow={onOpenFlow} />
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
    settingEntry('settings.defaultAgent', 'execution'),
    ...AGENT_IDS.map((agent): SettingEntry => ({
      label: { key: 'settings.agentArgs', vars: { agent: agentName(agent) } }, path: ['settings.section.execution', 'settings.defaultAgent'],
      view: { section: 'execution' }, anchor: settingAnchor('settings.agentArgs', agent),
    })),
    settingEntry('settings.group.waiting', 'execution'),
    ...SESSION_SYNONYMS.map(([row, keys]) => settingEntry(`settings.sessions.${row}`, 'execution', 'settings.group.waiting', keys)),
    ...cardEntries('execution', 'settings.group.branches', ['settings.branch', 'settings.baseBranch', 'settings.baseBranch.perWorkspace']),
    ...cardEntries('execution', 'settings.deleteActivity', ['settings.deleteActivity.session', 'settings.deleteActivity.transcripts', 'settings.deleteActivity.nonAutoTasks']),
  ];
}
