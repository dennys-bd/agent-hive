// JSON's highlighting (#793). Monaco ships JSON only as a language service with its own worker, which the Hive does not bundle: validation
// is the installed language server's (#780), and both at once would show every error twice. So .json and .jsonc get this Monarch tokenizer
// under the Monaco id `json`. The token names are the ones Monaco's JSON service uses, so its built-in themes already tell keys from values.
import type * as Monaco from 'monaco-editor';

type Api = Pick<typeof Monaco.languages, 'register' | 'setMonarchTokensProvider' | 'setLanguageConfiguration'>;

const JSON_TOKENS: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.json',
  tokenizer: {
    root: [
      [/\s+/, ''],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      // A key is a whole string with its colon ahead on the same line; one whose colon sits on the next line is painted as a value
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      // Not closed on its line: kept to the line, so the string state never swallows the lines after it
      [/"(?:[^"\\]|\\.)*\\?$/, 'string.invalid'],
      [/"/, 'string.value', '@string'],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}[\]]/, 'delimiter.bracket'],
      [/[,:]/, 'delimiter'],
    ],
    string: [
      [/[^"\\]+/, 'string.value'],
      [/\\./, 'string.escape'],
      [/"/, 'string.value', '@pop'],
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/\*/, 'comment'],
    ],
  },
};

// Without a configuration a Monaco language gets no bracket matching, no auto-close and no ⌘/ toggle
const JSON_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
};

/** The Monaco language `json` for .json and .jsonc (#793). Called before the catalog's languages register, so neither extension lands in `web`. */
export function registerJson(languages: Api): void {
  languages.register({ id: 'json', extensions: ['.json', '.jsonc'], aliases: ['JSON'] });
  languages.setMonarchTokensProvider('json', JSON_TOKENS);
  languages.setLanguageConfiguration('json', JSON_CONFIGURATION);
}
