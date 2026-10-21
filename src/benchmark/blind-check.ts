export interface BlindInput { where: string; text: string } // where: `task <key>`, `stage <role>`, `seed/<path>`, `custom/<origin>/<name>/<version>/<path>`
export interface BlindLeak { where: string; word: string }

const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \b is ASCII-only in JS: `braço` would never end a word. Letters and digits of any script bound a word instead
const wordPattern = (word: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(word)}(?![\\p{L}\\p{N}_])`, 'iu');

/** The first forbidden word a worker would read, by input then by word: case-insensitive, whole word in any script. */
export function blindLeak(inputs: readonly BlindInput[], words: readonly string[]): BlindLeak | undefined {
  const patterns = words.filter((w) => w.trim() !== '').map((word) => ({ word, pattern: wordPattern(word.trim()) }));
  for (const { where, text } of inputs) {
    const hit = patterns.find(({ pattern }) => pattern.test(text));
    if (hit) return { where, word: hit.word };
  }
  return undefined;
}
