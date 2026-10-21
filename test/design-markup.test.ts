import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attrOf, enclosingStart, matchingEnds, scanTags, topLevelStarts } from '../src/design-markup.js';

const shape = (html: string): string[] =>
  scanTags(html).map(({ name, isEnd, isSelfClosing }) => `${isEnd ? '/' : ''}${name}${isSelfClosing ? '/' : ''}`);

test('scanTags reads start, end and self-closing tags in lower case, a > inside a quoted value included, and nothing in a comment, a script or a style body (#421)', () => {
  const html = '<A title="a > b">x</A><br/><!-- <hv-include src="c.html"> --><script>if (a < b) "<hv-slot>";</script><STYLE>p::before { content: "<p>" }</STYLE><hv-include src=\'d.html\'/>';
  assert.deepEqual(shape(html), ['a', '/a', 'br/', 'script', '/script', 'style', '/style', 'hv-include/']);
  const [a] = scanTags(html);
  assert.equal(html.slice(a.start, a.end), '<A title="a > b">');
  assert.deepEqual(shape('<p>an unclosed <!-- comment <b>x</b>'), ['p'], 'an unclosed comment runs to the end');
});

test('attrOf reads a value in double, single or no quotes, in any case, and never a longer name ending the same or a bare attribute (#421)', () => {
  assert.deepEqual(
    [attrOf(' src="a.html"', 'src'), attrOf(" SRC='b.html'", 'src'), attrOf(' src=c.html/', 'src'), attrOf(' data-src="x"', 'src'), attrOf(' name', 'name')],
    ['a.html', 'b.html', 'c.html', undefined, undefined],
  );
});

test('topLevelStarts skips what nests, void and self-closing elements included; enclosingStart names the innermost open element; matchingEnds counts nesting (#421)', () => {
  const html = '<div><div><img><p>x</p></div></div><hr><span/><nav>y</nav>';
  const tags = scanTags(html);
  assert.deepEqual(topLevelStarts(tags).map((tag) => tag.name), ['div', 'hr', 'span', 'nav']);
  assert.equal(enclosingStart(tags, html.indexOf('x'))?.name, 'p');
  assert.equal(enclosingStart(tags, html.indexOf('<hr>')), undefined);
  assert.equal(matchingEnds(tags, 'div').get(tags[0])?.start, html.indexOf('</div></div>') + '</div>'.length);
});
