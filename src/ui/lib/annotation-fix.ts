// The one-click fixes of the editor's annotations (#327): the three checks with one obvious edit. Derived from the check here, so the lint's
// own `fix` stays free for the agent reviewer (4.2). #981: the agent's fix is its span replaced, and this file owns every finding's kind.
// Pure; compiled by the main tsc too, hence the .js imports.
import { type AgentAnnotation, type AgentFix, type FindingKind, spanAt } from '../../reviewer.js';
import { addVariable, type EditResult, removeVariable, setHeadingLevel } from '../../template-edit.js';
import type { LintAnnotation } from '../../template-lint.js';

/** Whether the card offers "apply fix": cheap, so a card asks it on every render without running the edit. An agent finding has one when
 * its kind is fix (#981). */
export function hasFix(annotation: LintAnnotation | AgentAnnotation): boolean {
  if ('source' in annotation) return annotation.kind === 'fix';
  const { check, variable, level } = annotation;
  if (check === 'unused' || check === 'undeclared') return variable !== undefined;
  return check === 'heading' && level !== undefined;
}

/** A finding's kind (#981): the agent's says its own; a lint finding is a fix exactly when it has one. The card reads this and decides nothing. */
export function kindOf(annotation: LintAnnotation | AgentAnnotation): FindingKind {
  if ('source' in annotation) return annotation.kind;
  return hasFix(annotation) ? 'fix' : 'advice';
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

/** An agent fix's new text (#981): its span's one occurrence on its current line replaced; undefined once the text no longer holds it there. */
export function agentFixOf(annotation: AgentFix, text: string): string | undefined {
  const at = spanAt(text, annotation.line, annotation.span);
  return at === undefined ? undefined : text.slice(0, at) + annotation.replacement + text.slice(at + annotation.span.length);
}
