// Claude Code's permission matching as code.claude.com/docs/en/permissions documents it (CLI 2.1.287), for the tests to check the
// worker rules against: deny first, then allow, an allow never carves an exception out of a deny; anything else asks.
const literal = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** A Bash rule against one simple command: `*` matches any text, spaces included, anywhere; `:*` at the end is ` *`; a trailing ` *`
 *  that is the rule's only wildcard also matches the bare command; a rule with no `*` matches that exact command only. */
export function bashMatches(rule: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (body === undefined) return false;
  const spec = body.endsWith(':*') ? `${body.slice(0, -2)} *` : body;
  const parts = spec.split('*');
  if (parts.length === 1) return spec === command;
  if (parts.length === 2 && spec.endsWith(' *') && command === spec.slice(0, -2)) return true;
  return new RegExp(`^${parts.map(literal).join('.*')}$`, 's').test(command);
}

/** A `Read(//abs/…)` rule against an absolute path, gitignore style: `*` within one segment, `**` across; a matched folder covers its files. */
export function readMatches(rule: string, path: string): boolean {
  const body = /^Read\(\/(\/.*)\)$/.exec(rule)?.[1];
  if (body === undefined) return false;
  const pattern = new RegExp(`^${body.split('**').map((part) => part.split('*').map(literal).join('[^/]*')).join('.*')}$`);
  const segments = path.split('/');
  return segments.some((_, i) => i > 0 && pattern.test(segments.slice(0, i + 1).join('/')));
}

export type Decision = 'allow' | 'deny' | 'ask';
const decide = (match: (rule: string) => boolean, allow: readonly string[], deny: readonly string[]): Decision =>
  (deny.some(match) ? 'deny' : allow.some(match) ? 'allow' : 'ask');

export const bashDecision = (allow: readonly string[], deny: readonly string[], command: string): Decision => decide((r) => bashMatches(r, command), allow, deny);
export const readDecision = (allow: readonly string[], deny: readonly string[], path: string): Decision => decide((r) => readMatches(r, path), allow, deny);

/** One flag's rules: a space inside Bash(...) belongs to the rule. */
export const rulesOf = (args: readonly string[], flag: string): string[] => {
  const i = args.indexOf(flag);
  return i === -1 ? [] : (args[i + 1] ?? '').split(/ (?![^(]*\))/).filter((r) => r !== '');
};
