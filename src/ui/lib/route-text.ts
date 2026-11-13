import type { FilterRule, RuleOp } from '../../types.js';
import { t } from '../i18n.js';

/** Settings' words for a task-properties rule's op: the ignore-case variants read the same, the case is a checkbox there. */
export const opWord = (op: RuleOp): string => t(op === 'equals' || op === 'iequals' ? 'settings.workspaceRules.op.equals' : 'settings.workspaceRules.op.contains');

/** Why a source's filter leaves a draft out (#773): one sentence per criterion and op. */
export function filterSentence(source: string, rule: FilterRule): string {
  const values = rule.field === 'blocked' ? '' : rule.values.join(t('create.route.or'));
  const name = rule.field === 'projectField' ? rule.name : '';
  return t(`create.route.filter.${rule.field}.${rule.op}`, { source, values, name });
}
