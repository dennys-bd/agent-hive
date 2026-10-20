// The one-click fixes of the editor's annotations (#327): the three checks with one obvious edit. Derived from the check here, so the lint's
// own `fix` stays free for the agent reviewer (4.2). Pure; compiled by the main tsc too, hence the .js imports.
import type { AgentAnnotation } from '../../reviewer.js';
import { addVariable, type EditResult, removeVariable, setHeadingLevel } from '../../template-edit.js';
import type { LintAnnotation } from '../../template-lint.js';

/** Whether the card offers "apply fix": cheap, so a card asks it on every render without running the edit. The agent sends no fix (#328). */
export function hasFix(annotation: LintAnnotation | AgentAnnotation): boolean {
  if ('source' in annotation) return false;
  const { check, variable, level } = annotation;
  if (check === 'unused' || check === 'undeclared') return variable !== undefined;
  return check === 'heading' && level !== undefined;
}

/** The fix's edit of `text`: unused removes the declaration, undeclared declares it with default null, heading sets the level the map nests it
 * as; undefined for every other check. */
export function fixOf(annotation: LintAnnotation, text: string): EditResult | undefined {
  const { check, variable, line, level } = annotation;
  if (check === 'unused' && variable !== undefined) return removeVariable(text, variable);
  if (check === 'undeclared' && variable !== undefined) return addVariable(text, { name: variable, default: null });
  if (check === 'heading' && level !== undefined) return setHeadingLevel(text, line, level);
  return undefined;
}
