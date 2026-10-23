import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { refusalText, runHiveUrl } from '@/lib/benchmark-run-api';

beforeEach(() => setLanguage('en'));

const refused = (message: string): unknown => ({ body: { error: 'blindness', message } });
const LOCATION = { protocol: 'http:', hostname: '127.0.0.1' };

test('a blindness refusal names the place after the last " in ", and a message without one reads unexpected, never the raw text (#465 review)', () => {
  expect(refusalText(refused('blindness: "a in b" in task X'))).toContain('task X');
  expect(refusalText(refused('blindness: "a in b" in task X'))).not.toContain('b"');
  expect(refusalText(refused('something else entirely'))).toBe(refusalText({ body: { error: 'nope' } }));
});

test('the run Hive URL takes only a port number in range: anything else throws instead of navigating off this host (#465 review)', () => {
  expect(runHiveUrl(4321, LOCATION)).toBe('http://127.0.0.1:4321/');
  for (const port of [0, 65_536, 1.5, '1@evil.com' as unknown as number]) expect(() => runHiveUrl(port, LOCATION)).toThrow();
});
