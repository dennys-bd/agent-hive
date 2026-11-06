import { expect, test } from 'vitest';
import { LAYOUT_PRESETS, loadMessage, parseDrawioFile } from '@/lib/drawio-file';

const MODEL = '<diagram id="d"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>';
const CHROME = { action: 'load', autosave: 1, noSaveBtn: 1, noExitBtn: 1 };

test('plain draw.io XML answers xml, the text exactly as read (#956)', () => {
  const text = `<mxfile host="drawio">${MODEL}</mxfile>`;
  expect(parseDrawioFile(text)).toEqual({ kind: 'xml', xml: text });
});

test('each of the six hive-layout presets answers layout, the marker removed and every other attribute and cell kept (#956)', () => {
  for (const preset of LAYOUT_PRESETS) {
    expect(parseDrawioFile(`<mxfile host="hive" hive-layout="${preset}">${MODEL}</mxfile>`), preset).toEqual({ kind: 'layout', preset, xml: `<mxfile host="hive">${MODEL}</mxfile>` });
  }
});

test('an unknown preset answers xml as read: draw.io loads it with no layout, and its first autosave drops the marker (#956)', () => {
  const text = `<mxfile hive-layout="spiral">${MODEL}</mxfile>`;
  expect(parseDrawioFile(text)).toEqual({ kind: 'xml', xml: text });
});

test('an mxfile holding <hive-mermaid> answers mermaid with its text, entities decoded (#956)', () => {
  expect(parseDrawioFile('<mxfile><hive-mermaid>flowchart TD\n  A --&gt; B</hive-mermaid></mxfile>')).toEqual({ kind: 'mermaid', text: 'flowchart TD\n  A --> B' });
});

test('text that does not parse as XML, or whose root is no mxfile, answers xml unchanged: draw.io shows its own error (#956)', () => {
  for (const text of ['<mxfile hive-layout="verticalFlow"><diagram>', 'not xml at all', '<mxGraphModel hive-layout="verticalFlow"/>']) {
    expect(parseDrawioFile(text), text).toEqual({ kind: 'xml', xml: text });
  }
});

test('loadMessage posts the XML, with its preset as layout, or Mermaid as a descriptor; always autosave, no save and no exit button (#956)', () => {
  expect(loadMessage({ kind: 'xml', xml: 'X' })).toEqual({ ...CHROME, xml: 'X' });
  expect(loadMessage({ kind: 'layout', xml: 'X', preset: 'organic' })).toEqual({ ...CHROME, xml: 'X', layout: 'organic' });
  expect(loadMessage({ kind: 'mermaid', text: 'M' })).toEqual({ ...CHROME, descriptor: { format: 'mermaid', data: 'M' } });
});
