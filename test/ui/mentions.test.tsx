import { expect, test } from 'vitest';
import { chipId, chipText, matchesQuery, mentionAt, segmentsOf, stripMention, withChip } from '@/lib/mentions';

test('mentionAt finds the @word under the caret, at the start or after a space, never inside a word (#591)', () => {
  expect(mentionAt('ask @cla', 8)).toEqual({ start: 4, query: 'cla' });
  expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
  expect(mentionAt('mail@x', 6)).toBeUndefined();
  expect(mentionAt('ask @cla more', 13)).toBeUndefined();
});

test('stripMention takes the typed @word out of the text; the delivered text carries no chip (#591)', () => {
  expect(stripMention('ask @cla now', { start: 4, query: 'cla' }, 8)).toBe('ask  now');
});

test('a chip names four characters of the id, nova for a new session; several chips, each once (#591)', () => {
  expect(chipId('e41f9a00-1', 'nova')).toBe('e41f');
  expect(chipId('new', 'nova')).toBe('nova');
  expect(withChip(withChip(['a'], 'b'), 'a')).toEqual(['a', 'b']);
  expect(matchesQuery('claude e41f9a00', 'E41')).toBe(true);
  expect(matchesQuery('claude e41f9a00', 'zz')).toBe(false);
});

// A chip is a word of the field's text: @, an em space the icon is drawn over, ·, the id's four characters
const E41 = { id: 'e41f9a00-1', text: chipText('e41f9a00-1', 'nova') };
const NEW = { id: 'new', text: chipText('new', 'nova') };

test('a chip\'s text is @, the icon\'s em space, · and its four characters (#591)', () => {
  expect(E41.text).toBe('@\u2003·e41f');
  expect(NEW.text).toBe('@\u2003·nova');
});

test('segmentsOf cuts the text into plain runs and its chips, in order, wherever they sit (#591)', () => {
  expect(segmentsOf(`see ${NEW.text} and ${E41.text} `, [E41, NEW])).toEqual([
    { text: 'see ' }, { text: NEW.text, chip: 'new' }, { text: ' and ' }, { text: E41.text, chip: E41.id }, { text: ' ' },
  ]);
  expect(segmentsOf('', [E41])).toEqual([]);
  expect(segmentsOf('plain', [])).toEqual([{ text: 'plain' }]);
});
