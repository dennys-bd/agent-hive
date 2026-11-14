import { useContext } from 'react';
import { REF_GRAMMARS, type RefGrammar } from '../../blocker-refs';
import { CreateTargetsContext } from '@/lib/create-targets';

/** #810 decision 10: the ref grammar of the source named `source`, by its type in comb.sources, which the Dashboard provides as
 * CreateTargetsContext's configs. Undefined for hive, and for a source the config does not hold: such an item reads only a task id.
 * A component rendered outside the Dashboard's provider therefore reads only task ids. */
export function useRefGrammar(source: string): RefGrammar | undefined {
  const type = useContext(CreateTargetsContext).configs?.find((s) => s.name === source)?.type;
  return type === undefined ? undefined : REF_GRAMMARS[type];
}
