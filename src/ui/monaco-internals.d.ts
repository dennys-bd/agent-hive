// Monaco's own line diff (#668), the one VS Code's diff editor and quick diff run: an internal ESM module of monaco-editor that ships no
// typings, declared here only as far as line-changes.ts uses it. Lines are 1-based, endLineNumberExclusive past the range's last line.
declare module 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js' {
  export interface LineRange { readonly startLineNumber: number; readonly endLineNumberExclusive: number }
  export interface LineRangeMapping { readonly original: LineRange; readonly modified: LineRange }
  export interface LinesDiff { readonly changes: readonly LineRangeMapping[]; readonly hitTimeout: boolean }
  export interface LinesDiffOptions { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }
  export class DefaultLinesDiffComputer {
    computeDiff(originalLines: string[], modifiedLines: string[], options: LinesDiffOptions): LinesDiff;
  }
}
