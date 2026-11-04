import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t, tPlural } from '@/i18n';
import type { FlowDraft } from '@/lib/settings-flows';
import { flowNameProblem } from '@/lib/settings-flows';

// Settings › fluxo's flow row (#565): the etapas card's first row in the design. Rendered inside StageEditor, keyed on the open flow, so its local
// state resets on every tab.

export interface FlowRowProps {
  flows: readonly FlowDraft[]; open: string; isAdding: boolean;
  taskCount: number; // the open flow's saved tasks (flowTaskCount): excluir fluxo refuses while it is > 0
  onOpen(id: string): void; onAdding(isAdding: boolean): void; onCreate(name: string): void; onRename(name: string): void; onRemove(): void;
}

function Problem({ name, flows, id }: { name: string; flows: readonly FlowDraft[]; id?: string }) {
  const key = flowNameProblem(name, flows, id);
  return key === undefined ? null : <p className="text-destructive text-xs">{t(key, { name: name.trim() })}</p>;
}

// + fluxo's inline form: the name is judged as it is typed, but a blank field is not scolded before the first key
function NewFlowForm({ flows, onCreate, onCancel }: { flows: readonly FlowDraft[]; onCreate(name: string): void; onCancel(): void }) {
  const [name, setName] = useState('');
  return (
    <div className="flex items-center gap-2">
      <Input aria-label={t('settings.flows.newName')} autoFocus className="w-48" value={name} onChange={(e) => setName(e.target.value)} />
      {name.trim() !== '' && <Problem name={name} flows={flows} />}
      <Button type="button" size="sm" disabled={flowNameProblem(name, flows) !== undefined} onClick={() => onCreate(name.trim())}>{t('settings.flows.create')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('settings.flows.cancel')}</Button>
    </div>
  );
}

export function FlowRow({ flows, open, isAdding, taskCount, onOpen, onAdding, onCreate, onRename, onRemove }: FlowRowProps) {
  const [holding, setHolding] = useState(false);
  const current = flows.find((f) => f.id === open);
  const isLast = flows.length === 1;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs">{t('settings.flows.label')}</span>
      <ToggleGroup type="single" variant="outline" value={open} onValueChange={(id) => { if (id) onOpen(id); }}>
        {flows.map((f) => <ToggleGroupItem key={f.id} value={f.id}>{f.name.trim() || t('settings.flows.unnamed')}</ToggleGroupItem>)}
      </ToggleGroup>
      <Button type="button" variant="ghost" size="sm" onClick={() => onAdding(true)}>{t('settings.flows.add')}</Button>
      {isAdding && <NewFlowForm flows={flows} onCreate={(n) => { onCreate(n); onAdding(false); }} onCancel={() => onAdding(false)} />}
      {current && (
        <>
          <Label htmlFor={`flow-name-${open}`}>{t('settings.flows.name')}</Label>
          <Input id={`flow-name-${open}`} className="w-48" defaultValue={current.name} onChange={(e) => onRename(e.target.value)} />
          <Problem name={current.name} flows={flows} id={open} />
        </>
      )}
      <Button type="button" variant="ghost" size="sm" disabled={isLast} onClick={() => (taskCount > 0 ? setHolding(true) : onRemove())}>{t('settings.flows.remove')}</Button>
      {isLast && <span className="text-muted-foreground text-xs">{t('settings.flows.lastFlow')}</span>}
      {holding && <p className="text-destructive text-xs">{tPlural('settings.flows.holdsTasks', taskCount, { n: taskCount })}</p>}
    </div>
  );
}
