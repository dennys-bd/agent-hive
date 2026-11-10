// A word PowerShell reads literally (#645): its single-quoted string, where the only escape is a quote doubled. PowerShell reads the
// four typographic single quotes as ' too, so each is doubled as well. A module of its own, with no imports: shell-init.ts writes the
// profile with it, and the dashboard, which cannot import node:fs, types a pasted path with it.
const PWSH_QUOTES = /['‘’‚‛]/g;

export const pwshQuote = (s: string): string => `'${s.replace(PWSH_QUOTES, '$&$&')}'`;
