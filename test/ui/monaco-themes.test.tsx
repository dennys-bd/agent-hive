import { expect, test, vi } from 'vitest';
import { followEditorTheme } from '@/lib/monaco-themes';

test('the theme carries the diagnostic, ruler, suggest and hover colours, and the TextMate rules vs and vs-dark lack (#780)', () => {
  const defineTheme = vi.fn();
  const stop = followEditorTheme({ defineTheme, setTheme: vi.fn() });
  const [, theme] = defineTheme.mock.calls[0] as [string, { colors: Record<string, string>; rules: { token: string }[] }];
  for (const key of ['editorError.foreground', 'editorWarning.foreground', 'editorInfo.foreground', 'editorOverviewRuler.errorForeground', 'editorSuggestWidget.background', 'editorSuggestWidget.selectedBackground', 'editorHoverWidget.background']) {
    expect(Object.keys(theme.colors)).toContain(key);
  }
  expect(theme.rules.map((r) => r.token)).toEqual(expect.arrayContaining(['storage', 'constant.numeric', 'entity.name.type']));
  stop();
});
