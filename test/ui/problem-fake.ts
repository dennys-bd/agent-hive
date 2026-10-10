import type { Counts, Problem } from '@/lib/problems';

/** A file's problems with these counts (#782), one per line, no code, from a language server: what a UI test feeds the store. */
export function problemsOf(path: string, { errors = 0, warnings = 0, infos = 0 }: Partial<Counts>, source = 'typescript-language-server'): Problem[] {
  const severities: Problem['severity'][] = [
    ...Array<Problem['severity']>(errors).fill('error'), ...Array<Problem['severity']>(warnings).fill('warning'), ...Array<Problem['severity']>(infos).fill('info'),
  ];
  return severities.map((severity, i) => ({ path, line: i + 1, column: 1, severity, message: `${severity} ${i + 1}`, source, fromServer: true }));
}
