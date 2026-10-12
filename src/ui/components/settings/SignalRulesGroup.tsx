import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { SignalRuler } from '@/components/settings/SignalRuler';
import { RulesEditor } from '@/components/settings/RulesEditor';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { MEASURES, measuresInUse } from '@/lib/settings-rules';
import { sourcePercent } from '@/lib/usage';
import type { RuleSource, State } from '../../../types';

interface SignalRulesGroupProps { draft: SettingsDraft; state?: State; onChange(patch: Partial<SettingsDraft>): void }

// Each rule carries its own measure; there is no view state (#526). One ruler per measure a rule uses, then the one table of every rule.
export function SignalRulesGroup({ draft, state, onChange }: SignalRulesGroupProps) {
  const now = Date.now();
  const percents: Partial<Record<RuleSource, number>> = state ? Object.fromEntries(MEASURES.map((s) => [s, sourcePercent(state, { source: s }, now)])) : {};
  const inUse = measuresInUse(draft.rules);
  const stages = draft.stages.map((s) => s.name.trim()).filter((name) => name !== '');

  return (
    <SettingsGroup title="settings.group.rules" hint="settings.group.rules.hint">
      {inUse.length > 0 && (
        <>
          <div className="flex flex-col gap-3.5">
            {inUse.map((source) => <SignalRuler key={source} source={source} rows={draft.rules.filter((r) => r.source === source)} current={percents[source]} />)}
          </div>
          <p className="text-muted-foreground text-xs">{t('settings.rules.caption')}</p>
        </>
      )}
      <RulesEditor rules={draft.rules} stages={stages} now={percents} onChange={(rules) => onChange({ rules })} />
      <p className="text-muted-foreground text-xs">{t('settings.rulesHint')}</p>
    </SettingsGroup>
  );
}
