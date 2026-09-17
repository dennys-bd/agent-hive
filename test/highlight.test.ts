import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, highlight, renderOutput } from '../src/ui/highlight.js';

test('esc escapes the five HTML-significant characters and nothing else', () => {
  assert.equal(esc(`<a href="x">'&'</a> \`ok\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt; `ok`');
});

test('text outside a fence is escaped and `inline code` becomes <code>', () => {
  assert.equal(
    renderOutput(['<script>alert(1)</script>', 'use `pnpm test` & go', '▶ Bash: echo `a`']),
    '&lt;script&gt;alert(1)&lt;/script&gt;\nuse <code>pnpm test</code> &amp; go\n▶ Bash: echo <code>a</code>',
  );
});

test('a diff fence colours added, removed and hunk lines and escapes their content', () => {
  const html = renderOutput(['▶ Edit: a.ts', '```diff', '@@ -1 +1 @@', '-const a = "<x>";', '+const a = 1;', ' same', '```', 'depois']);
  assert.equal(html, [
    '▶ Edit: a.ts',
    '<pre class="code" data-lang="diff"><span class="hunk">@@ -1 +1 @@</span>\n'
      + '<span class="del">-const a = &quot;&lt;x&gt;&quot;;</span>\n'
      + '<span class="add">+const a = 1;</span>\n'
      + ' same</pre>',
    'depois',
  ].join('\n'));
});

test('a ts fence marks comments, strings, numbers and keywords without overlap, escaping as it goes', () => {
  assert.equal(
    highlight('ts', 'const n = 42; // "not a string"\nconst s = "a // b"; # <tag>'),
    '<span class="keyword">const</span> n = <span class="number">42</span>; <span class="comment">// &quot;not a string&quot;</span>\n'
      + '<span class="keyword">const</span> s = <span class="string">&quot;a // b&quot;</span>; <span class="comment"># &lt;tag&gt;</span>',
  );
  assert.equal(highlight('py', 'x1 = None'), 'x1 = <span class="keyword">None</span>', 'a digit inside an identifier is not a number');
  assert.equal(highlight('', '/* a\nb */ 3.14'), '<span class="comment">/* a\nb */</span> <span class="number">3.14</span>');
});

test('an unclosed fence runs to the end of the output', () => {
  assert.equal(renderOutput(['antes', '```sh', 'pnpm test', 'echo "x"']), 'antes\n<pre class="code" data-lang="sh">pnpm test\n<span class="keyword">echo</span> <span class="string">&quot;x&quot;</span></pre>');
});

test('a fence inside one output line with embedded newlines renders like separate lines; a fence without a language has an empty data-lang', () => {
  assert.equal(renderOutput(['antes\n```\nx < y\n```\ndepois']), 'antes\n<pre class="code" data-lang="">x &lt; y</pre>\ndepois');
  assert.equal(renderOutput([]), '');
});
