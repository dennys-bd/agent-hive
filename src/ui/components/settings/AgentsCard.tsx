import { useState } from 'react';
import { ModelMenu } from '@/components/LaunchMenus';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { FIELD, FIELD_LABEL } from '@/components/settings/field-row';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import { agentName, isAvailable } from '../../../agents';
import { AGENT_IDS, type AgentAvailability, type AgentId, type AgentLaunchOptions } from '../../../types';

// Settings › execução's agentes (#482, the handoff): one section per agent, its mark in its own colour (design system "Agent colour"), the
// default's badge or tornar padrão, the habilitado switch (the default's is locked on), then its default model and its arguments (#924). An
// agent boot did not find shows why and no fields: availability is boot's finding (#516), never written to agentEnabled.

type Patch = (patch: Partial<SettingsDraft>) => void;
interface AgentsCardProps { draft: SettingsDraft; agents: readonly AgentAvailability[]; launchWorkspace?: string; onChange: Patch; onOpenFlow(): void }
interface SectionProps { agent: AgentId; draft: SettingsDraft; onChange: Patch }

// The line beside the name: why it cannot run, or "installed"
function statusOf(agent: AgentId, draft: SettingsDraft, isInstalled: boolean): string {
  const name = agentName(agent);
  if (!isInstalled) return [t('settings.agents.missing', { agent: name }), ...(draft.defaultAgent === agent ? [t('settings.agents.missingDefault')] : [])].join(' · ');
  return draft.agentEnabled[agent] ? t('settings.agents.installed') : t('settings.agents.disabled', { agent: name });
}

function AgentHeader({ agent, draft, isInstalled, onChange }: SectionProps & { isInstalled: boolean }) {
  const isDefault = draft.defaultAgent === agent;
  const isOn = isInstalled && draft.agentEnabled[agent];
  const id = `settings-agent-enabled-${agent}`;
  return (
    <div id={settingAnchor('settings.agents.enabled.of', agent)} className="flex items-center gap-2">
      <AgentIcon agent={agent} className={`size-4 ${AGENT_COLOR[agent] ?? ''}`} />
      <span className="font-semibold text-sm">{agentName(agent)}</span>
      <span className="text-muted-foreground text-xs">{statusOf(agent, draft, isInstalled)}</span>
      <span className="ml-auto flex items-center gap-3">
        {isDefault
          ? <Badge variant="secondary">{t('settings.agents.default')}</Badge>
          : isOn && <Button type="button" variant="outline" size="sm" onClick={() => onChange({ defaultAgent: agent })}>{t('settings.agents.makeDefault')}</Button>}
        <Switch
          id={id} aria-label={t('settings.agents.enabled.of', { agent: agentName(agent) })} checked={isOn} disabled={!isInstalled || isDefault}
          title={isDefault && isInstalled ? t('settings.agents.lockedDefault') : undefined}
          onCheckedChange={(on) => onChange({ agentEnabled: { ...draft.agentEnabled, [agent]: on } })}
        />
        <Label htmlFor={id} className="font-normal text-sm">{t('settings.agents.enabled')}</Label>
      </span>
    </div>
  );
}

// modelo and argumentos; at half opacity and inert while the agent is off, so nothing in them takes a click or the focus
function AgentFields({ agent, draft, options, onChange }: SectionProps & { options?: AgentLaunchOptions }) {
  const [isOpen, setOpen] = useState(false);
  const isOn = draft.agentEnabled[agent];
  const name = agentName(agent);
  return (
    <div className={`grid grid-cols-[20rem_minmax(0,1fr)] gap-3 ${isOn ? '' : 'opacity-50'}`} inert={!isOn}>
      <div id={settingAnchor('settings.agents.model.of', agent)} className={FIELD}>
        <span className={FIELD_LABEL}>{t('newSession.model')}</span>
        <ModelMenu
          label={t('settings.agents.model.of', { agent: name })} agent={agent} options={options} value={draft.agentModels[agent]} open={isOpen} onOpenChange={setOpen}
          onPick={(model) => onChange({ agentModels: { ...draft.agentModels, [agent]: model } })}
        />
      </div>
      <div id={settingAnchor('settings.agentArgs', agent)} className={FIELD}>
        <Label htmlFor={`settings-agent-args-${agent}`} className={FIELD_LABEL}>{t('newSession.args')}</Label>
        <Input
          id={`settings-agent-args-${agent}`} aria-label={t('settings.agentArgs', { agent: name })} className="font-mono" placeholder={t('settings.agents.args.none')}
          value={draft.agentArgs[agent]} onChange={(e) => onChange({ agentArgs: { ...draft.agentArgs, [agent]: e.target.value } })}
        />
        <p className="text-muted-foreground text-xs">{t('settings.agentArgs.hint')}</p>
      </div>
    </div>
  );
}

export function AgentsCard({ draft, agents, launchWorkspace, onChange, onOpenFlow }: AgentsCardProps) {
  const options = useLaunchOptions(launchWorkspace); // the config's first workspace's lists, as ReviewerMenu reads them
  const hint = (
    <span className="text-muted-foreground text-xs">
      {t('settings.agents.hint')}{' '}<button type="button" className="text-review" onClick={onOpenFlow}>{t('settings.section.flow')}</button>
    </span>
  );
  return (
    <SettingsGroup title="settings.agents" control={hint} flush>
      {AGENT_IDS.map((agent) => {
        const isInstalled = isAvailable(agent, agents);
        return (
          <fieldset key={agent} aria-label={agentName(agent)} className="m-0 flex min-w-0 flex-col gap-3 border-0 border-t px-5 py-4 first:border-t-0">
            <AgentHeader agent={agent} draft={draft} isInstalled={isInstalled} onChange={onChange} />
            {isInstalled && <AgentFields agent={agent} draft={draft} options={options?.[agent]} onChange={onChange} />}
          </fieldset>
        );
      })}
    </SettingsGroup>
  );
}
