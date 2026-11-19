import { useState } from 'react';
import { sourceOf } from '../../tasks';
import type { Relation, RelationChange, State, Task } from '../../types';
import { BlockerRow, refState } from '@/components/BlockersSection';
import { RelationAddRow } from '@/components/RelationAddRow';
import { Button } from '@/components/ui/button';
import { useRefGrammar } from '@/hooks/use-ref-grammar';
import { useRelationTypes } from '@/hooks/use-relation-types';
import { useSectionEdit } from '@/hooks/use-section-edit';
import { t } from '@/i18n';
import { groupByPhrase, type RelationChoice, relationChoices } from '@/lib/relation-groups';
import { editRelation } from '@/lib/relations-api';

const MUTED = 'text-muted-foreground';
const ADDING = 'add'; // a row's key is `<type>:<direction>:<id>`, which never equals it

/** Whether a task shows the relations section (#829): a source item whose relations were read (every Jira task); GitHub and hive tasks have none. */
export const hasRelationsSection = (task: Task): boolean => task.item.relations !== undefined;

/** A Jira task's non-blocking links (#829, #958): grouped by phrase, each with its ×; `+ relação` opens the add row; a refusal shows inline by
 * its code. Rendered inside relacionamentos by BlockersSection, which DetailPanel keys by task. The list always comes from the state, which
 * the route's itemRead redraws. The types are read only for a task with relations, so the hooks live here. */
export function RelationsList({ task, state, relations }: { task: Task; state: State; relations: readonly Relation[] }) {
  const source = sourceOf(task);
  const grammar = useRefGrammar(source);
  const choices = relationChoices(useRelationTypes(source));
  const [isAdding, setIsAdding] = useState(false);
  const { pending, error, edit } = useSectionEdit((change: RelationChange) => editRelation(source, task.item.itemId, change), grammar);
  const add = async (choice: RelationChoice, ref: string): Promise<void> => {
    if (await edit(ADDING, { action: 'add', type: choice.type, direction: choice.direction, ref })) setIsAdding(false);
  };
  return (
    <div data-slot="relations" className="flex flex-col gap-1.5">
      {groupByPhrase(relations).flatMap((group) => group.relations.map((r) => {
        const key = `${r.type}:${r.direction}:${r.id}`;
        return <BlockerRow key={key} label={group.phrase} blocker={r} stateText={refState(r, source, state.tasks)} isPending={pending === key} onRemove={() => void edit(key, { action: 'remove', type: r.type, direction: r.direction, ref: r.id })} />;
      }))}
      {relations.length === 0 && <p className={MUTED}>{t('relations.none')}</p>}
      {!isAdding && choices.length > 0 && <div><Button type="button" variant="ghost" size="xs" className="h-5 px-1 font-medium" onClick={() => setIsAdding(true)}>{t('relations.add')}</Button></div>}
      {isAdding && (
        <RelationAddRow
          source={source} itemId={task.item.itemId} selfId={task.item.id} relations={relations} choices={choices} isBusy={pending !== undefined} grammar={grammar}
          onAdd={(choice, ref) => void add(choice, ref)} onCancel={() => setIsAdding(false)}
        />
      )}
      {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
