import { type ReactNode, useContext, useState } from 'react';
import type { BenchStageRole, LaunchOptions } from '../../../../types';
import type { Draft } from '@/components/benchmark/arms/ArmSettings';
import { ROLES, readRow, type RowKey } from '@/components/benchmark/arms/arm-rows';
import { AgentField, type InheritRow, ModelMenu } from '@/components/LaunchMenus';
import { AgentsContext } from '@/components/NewRunButton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

interface PickFieldsProps { draft: Draft; role: BenchStageRole; options?: LaunchOptions; menu?: string; setMenu(menu?: string): void }

// In arm mode '' is the agent's own default (null over a base model); the base's model, when it names one, is a row of its own
function PickFields({ draft, role, options, menu, setMenu }: PickFieldsProps) {
  const agents = useContext(AgentsContext);
  const pick = draft.setup.stages[role];
  const baseModel = draft.base.stages[role].model;
  const inherit: InheritRow | undefined = draft.isArm && baseModel !== undefined
    ? { label: t('benchmark.arms.settings.baseModel', { model: baseModel }), isPicked: pick.model === baseModel, onPick: () => draft.edit(role, { agent: pick.agent, model: baseModel }) }
    : undefined;
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* another agent's model means nothing to it, as StageBlocks: the agent's own default */}
      <AgentField id={`arm-${role}-agent`} label={t('benchmark.arms.settings.agentOf', { role })} value={pick.agent} agents={agents} onOpenChange={() => undefined} onChange={(agent) => draft.edit(role, { agent })} />
      <ModelMenu
        id={`arm-${role}-model`} label={t('benchmark.arms.settings.modelOf', { role })} agent={pick.agent} options={options?.[pick.agent]} value={pick.model ?? ''}
        defaultLabel={draft.isArm ? t('benchmark.arms.settings.agentDefault') : undefined} inherit={inherit}
        open={menu === role} onOpenChange={(isOpen) => setMenu(isOpen ? role : undefined)} onPick={(model) => draft.edit(role, { agent: pick.agent, model })}
      />
    </div>
  );
}

function PerRoleFields({ draft, rowKey }: { draft: Draft; rowKey: 'skills' | 'prompts' }) {
  const values = readRow(draft.setup, rowKey);
  return (
    <div className="grid grid-cols-2 gap-2">
      {ROLES.map((role) => {
        const label = t(rowKey === 'skills' ? 'benchmark.arms.settings.skillOf' : 'benchmark.arms.settings.promptOf', { role });
        const change = (value: string): void => draft.edit(rowKey, { ...values, [role]: value });
        return rowKey === 'skills'
          ? <Input key={role} aria-label={label} value={values[role]} onChange={(e) => change(e.target.value)} className="font-mono text-xs" />
          : <Textarea key={role} aria-label={label} rows={3} value={values[role]} onChange={(e) => change(e.target.value)} className="text-xs" />;
      })}
    </div>
  );
}

interface StageFieldsProps { draft: Draft; options?: LaunchOptions; group(key: RowKey, children: ReactNode): ReactNode }

/** Each stage's agent · model, then the four skills and the four prompts, each a row of its own (#462). */
export function StageFields({ draft, options, group }: StageFieldsProps) {
  const [menu, setMenu] = useState<string>();
  return (
    <>
      {ROLES.map((role) => group(role, <PickFields draft={draft} role={role} options={options} menu={menu} setMenu={setMenu} />))}
      {group('skills', <PerRoleFields draft={draft} rowKey="skills" />)}
      {group('prompts', <PerRoleFields draft={draft} rowKey="prompts" />)}
    </>
  );
}
