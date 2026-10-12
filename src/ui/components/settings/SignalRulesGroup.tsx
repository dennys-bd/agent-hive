import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { SignalRuler } from '@/components/settings/SignalRuler';
import { RulesEditor } from '@/components/settings/RulesEditor';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { rulerRows, rulersInUse } from '@/lib/settings-rules';
import { sourcePercent } from '@/lib/usage';
import type { AgentId, RuleSource, State } from '../../../types';

interface SignalRulesGroupProps { draft: SettingsDraft; state?: State; onChange(patch: Partial<SettingsDraft>): void }

// Each rule carries its own measure and, on a plan measure, its agent (#526, #929); there is no view state. One ruler per measure and agent
// a rule uses, then the one table of every rule.
export function SignalRulesGroup({ draft, state, onChange }: SignalRulesGroupProps) {
  const now = Date.now();
  // the form's default agent, which may differ from the saved one while the form is open
  const percentOf = (source: RuleSource, agent: AgentId | undefined): number | undefined =>
    (state === undefined ? undefined : sourcePercent(state, { source, agent: agent ?? draft.defaultAgent }, now));
  const rulers = rulersInUse(draft.rules, draft.defaultAgent);
  const stages = draft.stages.map((s) => s.name.trim()).filter((name) => name !== '');

  return (
    <SettingsGroup title="settings.group.rules" hint="settings.group.rules.hint">
      {rulers.length > 0 && (
        <>
          <div className="flex flex-col gap-3.5">
            {rulers.map((ruler) => (
              <SignalRuler key={`${ruler.source}:${ruler.agent ?? ''}`} source={ruler.source} agent={ruler.agent} rows={rulerRows(draft.rules, ruler, draft.defaultAgent)} current={percentOf(ruler.source, ruler.agent)} />
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{t('settings.rules.caption')}</p>
        </>
      )}
      <RulesEditor rules={draft.rules} stages={stages} defaultAgent={draft.defaultAgent} now={(rule) => percentOf(rule.source, rule.agent)} onChange={(rules) => onChange({ rules })} />
      <p className="text-muted-foreground text-xs">{t('settings.rulesHint')}</p>
    </SettingsGroup>
  );
}
