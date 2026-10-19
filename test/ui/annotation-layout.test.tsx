import { expect, test } from 'vitest';
import { parseTemplate } from '../../src/template';
import type { LintAnnotation } from '../../src/template-lint';
import { buildMap } from '../../src/template-map';
import { dotsOf, layoutMargin, NOTE_HEIGHT, underlinesOf } from '@/lib/annotation-layout';
import { BUILD_TEXT } from './plugins-fixtures';

const at = (line: number, severity: LintAnnotation['severity'] = 'yellow'): LintAnnotation => ({ line, severity, check: 'reference', title: `t${line}`, body: '' });

test("the layout answers a note when a chip, or an earlier card, starts within a card's height, and a card otherwise (#327)", () => {
  expect(layoutMargin([40], [0], 96)).toEqual([{ kind: 'note', top: 0 }]);
  expect(layoutMargin([200], [0], 96)).toEqual([{ kind: 'card', top: 0 }]);
  expect(layoutMargin([], [0, 18, 120], 96)).toEqual([{ kind: 'card', top: 0 }, { kind: 'note', top: 18 }, { kind: 'card', top: 120 }]);
  expect(layoutMargin([10], [0, 0], 96)).toEqual([{ kind: 'note', top: 0 }, { kind: 'note', top: NOTE_HEIGHT }]);
});

test('a dot goes on the innermost row that holds the line, a header line on the first block, and a line no block holds has none (#327)', () => {
  // BUILD_TEXT: header 1–6, title 7, introduction 9–10, ## Input 11–19 holding a chain (if 14, else 16, endif 18), ## Stops 20–22
  const parsed = parseTemplate(BUILD_TEXT);
  const dots = dotsOf(buildMap(parsed), parsed.bodyLine, [at(3), at(7), at(12), at(15, 'red'), at(17), at(18), at(21)]);
  expect([...dots].map(([row, list]) => [row, list.map((a) => a.line)])).toEqual([[9, [3]], [11, [12]], [14, [15]], [16, [17, 18]], [20, [21]]]);
});

test('an underline runs from the first non-blank column to the end of each annotated line, in its severity; a blank line has none (#327)', () => {
  expect(underlinesOf([at(1, 'red'), at(2), at(3, 'red'), at(4)], 'a\n  b c\n   \n')).toEqual([
    { line: 1, from: 1, className: 'template-annotation-red' },
    { line: 2, from: 3, className: 'template-annotation-yellow' },
  ]);
});
