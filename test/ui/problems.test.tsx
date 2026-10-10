import { expect, test } from 'vitest';
import { countsOf, dedupe, groupProblems, type Problem } from '@/lib/problems';

const p = (path: string, line: number, severity: Problem['severity'], extra: Partial<Problem> = {}): Problem =>
  ({ path, line, column: 1, severity, message: `${severity} at ${line}`, source: 'tsc', fromServer: false, ...extra });

test('dedupe keeps the language server\'s copy of a problem a checker reports on the same path, line and code; one without a code stays (#782)', () => {
  const server = p('a.ts', 3, 'error', { code: '2304', source: 'typescript-language-server', fromServer: true });
  const tsc = p('a.ts', 3, 'error', { code: '2304' });
  const other = p('a.ts', 3, 'error');
  const elsewhere = p('a.ts', 4, 'error', { code: '2304' });
  expect(dedupe([tsc, server, other, elsewhere])).toEqual([server, other, elsewhere]);
});

test('groups put files with an error first, then with a warning, then by path; each file by line, then column (#782)', () => {
  const groups = groupProblems([
    p('b.ts', 9, 'warning'), p('z.ts', 1, 'warning', { column: 5 }), p('a.ts', 1, 'info'), p('z.ts', 1, 'error'), p('c.ts', 2, 'warning'), p('z.ts', 1, 'info', { column: 2 }),
  ]);
  expect(groups.map((g) => [g.path, g.worst])).toEqual([['z.ts', 'error'], ['b.ts', 'warning'], ['c.ts', 'warning'], ['a.ts', 'info']]);
  expect(groups[0].problems.map((x) => x.column)).toEqual([1, 2, 5]);
  expect(groups[0].counts).toEqual({ errors: 1, warnings: 1, infos: 1 });
  expect(countsOf([p('a', 1, 'error'), p('a', 2, 'info')])).toEqual({ errors: 1, warnings: 0, infos: 1 });
});
