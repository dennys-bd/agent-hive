import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import type { AgentAvailability, AgentId } from '../../../types';

// Radix refuses '' as an item value: the stage's "no pick" rides as this and maps back to ''.
const DEFAULT_ITEM = 'default';

interface AgentSelectProps {
  id: string;
  value: AgentId | '';
  agents: readonly AgentAvailability[];
  /** A stage's select (#516): the first item is padrão (<default>), which is ''. Absent on the default agent's own select. */
  defaultAgent?: AgentId;
  onChange(value: AgentId | ''): void;
}

// #516: one item per known agent, the id as its label; one boot did not find is disabled with the reason, as the boot's detection says (#516). A saved agent
// that went missing stays selected, and the trigger shows its bare id rather than the disabled item's text.
export function AgentSelect({ id, value, agents, defaultAgent, onChange }: AgentSelectProps) {
  const shown = value === '' && defaultAgent !== undefined ? t('settings.stages.agent.default', { agent: defaultAgent }) : value;
  return (
    <Select value={value === '' ? DEFAULT_ITEM : value} onValueChange={(v) => onChange(v === DEFAULT_ITEM ? '' : (v as AgentId))}>
      <SelectTrigger id={id} className="w-full"><SelectValue>{shown}</SelectValue></SelectTrigger>
      <SelectContent>
        {defaultAgent !== undefined && <SelectItem value={DEFAULT_ITEM}>{t('settings.stages.agent.default', { agent: defaultAgent })}</SelectItem>}
        {agents.map((a) => (
          <SelectItem key={a.agent} value={a.agent} disabled={!a.available}>
            {a.available ? a.agent : `${a.agent} · ${t('settings.agent.offPath')}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
