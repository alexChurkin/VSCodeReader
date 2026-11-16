import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import stringWidth from 'string-width';
import { readEpub } from '../src/epub';
import { readFb2 } from '../src/fb2';
import { readBook, extractImage, readTxt } from '../src/formats';
import { cleanPassage } from '../src/copy';
import { readMarkup } from '../src/markup';
import { Screen } from '../src/screen';
import { BookSearch } from '../src/search';
import { zip } from './fixtures';
import type { Book, Chapter } from '../src/book';

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function styled(chapter: Chapter, word: string) {
  const offset = chapter.text.indexOf(word);
  assert.ok(offset >= 0, word);
  return chapter.styles?.filter(span => span.offset <= offset && span.offset + span.length > offset) ?? [];
}
function epub(source: string, css: string): Buffer {
  return zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'],
    ['book.opf', '<package version="3.0"><metadata><title>Formatting fixture</title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="css" href="styles.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>'],
    ['chapter.xhtml', `<html><head><link rel="stylesheet" href="styles.css"/><link rel="stylesheet" href="https://example.com/never.css"/></head><body>${source}</body></html>`],
    ['styles.css', css],
  ]);
}

void test('EPUB loads publisher CSS headings and variable font weight without inserting terminal commands into book text', async () => {
  const book = await readEpub(epub('<p class="Heading-2" id="heading">Chapter heading</p><p class="Heading-3">Subheading</p><p>Body <span class="CharOverride-7">bold words</span> and <i>italics</i>.</p><ol start="3"><li>Third</li><li>Fourth</li></ol><pre>  code\n    indentation</pre>', 'p.Heading-2 {font-size:1.333em;font-variation-settings:"wght" 700} p.Heading-3 {font-size:1.167em;font-variation-settings:"wght" 700} span.CharOverride-7 {font-weight:bold}'));
  const chapter = book.chapters[0];
  assert.ok(styled(chapter, 'Chapter heading').some(span => span.bold && span.underline));
  assert.ok(styled(chapter, 'bold words').some(span => span.bold));
  assert.ok(styled(chapter, 'italics').some(span => span.italic));
  assert.match(chapter.text, /(?:^|\n)Subheading/); assert.match(chapter.text, /3\. Third/); assert.match(chapter.text, /4\. Fourth/);
  assert.match(chapter.text, /  code\n    indentation/);
  assert.doesNotMatch(chapter.text, /\x1b/);
  assert.equal(chapter.anchors.heading, chapter.text.indexOf('Chapter heading'));
  const screen = new Screen(book, '', { chapter: 0, offset: 0 }); screen.resize(80, 30);
  assert.match(screen.render(), /\x1b\[1;4mChapter heading/); assert.match(screen.render(), /\x1b\[1mbold words/);
});

void test('nested inline styles compose with search highlighting and explicit normal resets', () => {
  const { book } = readMarkup(Buffer.from('<style>p .weight {font-weight:700} .off {font-weight:normal !important}</style><h2>Heading</h2><p><strong>Bold <span class="off" style="font-weight:bold">plain</span> bold again</strong> <span class="weight"><em>mixed</em></span> <u>underlined</u> <del>deleted</del></p>'), 'a.html');
  const chapter = book.chapters[0];
  assert.ok(styled(chapter, 'Bold').some(span => span.bold));
  assert.ok(!styled(chapter, 'plain').some(span => span.bold));
  assert.ok(styled(chapter, 'mixed').some(span => span.bold && span.italic));
  assert.ok(styled(chapter, 'underlined').some(span => span.underline));
  assert.ok(styled(chapter, 'deleted').some(span => span.strike));
  const search = new BookSearch(book, 'mixed'); search.next({ chapter: 0, offset: 0 }, 1);
  const screen = new Screen(book, '', { chapter: 0, offset: 0 }); screen.resize(100, 20);
  assert.equal(strip(screen.render()), strip(screen.render(search.highlights(0))));
  assert.match(screen.render(search.highlights(0)), /\x1b\[1;3;7mmixed/);
});

const tableSource = '<h1>Data</h1><table><tr><th>Name</th><th>Value</th><th>Details</th></tr><tr><td>中文 👩‍💻</td><td><strong>Long cell with many words to wrap naturally and completely.</strong></td><td><a href="#note">[n]</a> <img src="pic.png" alt="Picture"/></td></tr></table><h2 id="note">Footnote</h2><p>Note body.</p>';
function assertCellsSurvive(book: Book, chapter: number, columns: number): Screen {
  const screen = new Screen(book, '', { chapter, offset: 0 }); screen.resize(columns, 200);
  for (const [index, line] of screen.lines.entries()) {
    assert.ok(stringWidth(line.text) < columns, `${columns}: ${line.text}`);
    if (index) assert.ok(line.offset >= screen.lines[index - 1].offset, 'Line anchors must remain monotonic');
  }
  for (const table of book.chapters[chapter].tables ?? []) for (const row of table.rows) for (const cell of row.cells) {
    const pieces = screen.lines.flatMap(line => (line.runs ?? []).filter(run => run.offset >= cell.offset && run.offset < cell.offset + cell.length).map(run => {
      assert.equal(line.text.slice(run.startIndex, run.startIndex + run.length), book.chapters[chapter].text.slice(run.offset, run.offset + run.length));
      return { offset: run.offset, text: line.text.slice(run.startIndex, run.startIndex + run.length) };
    })).sort((a, b) => a.offset - b.offset);
    assert.equal(pieces.map(piece => piece.text).join('').replace(/\s/g, ''), book.chapters[chapter].text.slice(cell.offset, cell.offset + cell.length).replace(/\s/g, ''));
  }
  return screen;
}

void test('tables adapt from bounded grids to row cards while preserving every cell and Unicode source mapping', () => {
  const { book } = readMarkup(Buffer.from(tableSource), 'table.html');
  assert.equal(book.chapters[0].tables?.length, 1);
  const wide = assertCellsSurvive(book, 0, 100);
  assert.match(strip(wide.render()), /\+---/); assert.match(strip(wide.render()), /\| Name/);
  for (const width of [80, 40, 20, 5]) assertCellsSurvive(book, 0, width);
  const narrow = assertCellsSurvive(book, 0, 30);
  assert.match(strip(narrow.render()), /Row 2/); assert.match(strip(narrow.render()), /Details:/);
});

void test('table links, search matches and text anchors remain correct across reflow', () => {
  const { book } = readMarkup(Buffer.from(tableSource), 'table.html');
  const chapter = book.chapters[0], offset = chapter.text.indexOf('naturally');
  const screen = new Screen(book, '[log] ', { chapter: 0, offset });
  for (const width of [120, 80, 40, 20]) {
    screen.resize(width, 200);
    assert.deepEqual(screen.locator, { chapter: 0, offset });
    const visible = screen.lines.slice(screen.row, screen.row + screen.rows);
    assert.ok(visible.some(line => line.runs?.some(run => run.offset <= offset && run.offset + run.length > offset)));
    screen.go({ chapter: 0, offset: 0 });
    const text = strip(screen.render()).split('\r\n');
    assert.ok(text.some(line => screen.footnoteLinks(line).length));
    assert.ok(text.some(line => screen.imageLinks(line).length));
    screen.go({ chapter: 0, offset });
  }
});

void test('merged and empty cells retain column positions and all content', () => {
  const { book } = readMarkup(Buffer.from('<table><caption>Results</caption><tr><th rowspan="2">Name</th><th colspan="2">Measures</th></tr><tr><th>First</th><th>Second</th></tr><tr><td>A</td><td></td><td>10</td></tr></table>'), 'table.html');
  const table = book.chapters[0].tables![0];
  assert.equal(book.chapters[0].text.slice(table.caption!.offset, table.caption!.offset + table.caption!.length), 'Results');
  assert.match(strip(new Screen(book, '', { chapter: 0, offset: 0 }).render()), /Results/);
  assert.equal(table.columns, 3); assert.equal(table.rows[1].cells[0].column, 1);
  assert.equal(table.rows[0].cells[1].colSpan, 2);
  assertCellsSurvive(book, 0, 100); assertCellsSurvive(book, 0, 20);
});

void test('local debug EPUB retains all five tables and publisher formatting', { skip: !process.env.READER_DEBUG_EPUB }, async () => {
  const book = await readEpub(await readFile(process.env.READER_DEBUG_EPUB!));
  assert.equal(book.chapters.flatMap(chapter => chapter.tables ?? []).length, 5);
  assert.ok(book.chapters.flatMap(chapter => chapter.styles ?? []).filter(style => style.bold).length > 500);
  for (const [chapter, content] of book.chapters.entries()) if (content.tables?.length) {
    assertCellsSurvive(book, chapter, 100); assertCellsSurvive(book, chapter, 30);
  }
});

void test('conditional CSS and generated content never hide or inject book text', () => {
  const { book } = readMarkup(Buffer.from('<style>@media print { p {display:none} strong {font-weight:normal} } @font-face {font-family:Remote;src:url(https://example.com/font)} p {font-weight:bold} p:before {content:"injected"}</style><p>Visible <strong>emphasis</strong></p>'), 'a.html');
  assert.match(book.chapters[0].text, /Visible emphasis/);
  assert.doesNotMatch(book.chapters[0].text, /injected|https:/);
  assert.ok(styled(book.chapters[0], 'Visible').some(span => span.bold));
});

for (const format of ['fb2', 'md'] as const) {
  void test(`${format} playground preserves semantic styles, prose indents, tables, links and anchors through reflow`, async () => {
    const bytes = await readFile(`samples/formatting.${format}`);
    const result = await readBook(bytes, { filename: `formatting.${format}` });
    assert.equal(result.kind, 'book'); if (result.kind !== 'book') return;
    const book = result.book, chapter = book.chapters[0];
    assert.ok(styled(chapter, 'Formatting playground').some(span => span.bold && span.underline));
    assert.ok(styled(chapter, 'bold words').some(span => span.bold));
    assert.ok(styled(chapter, 'italic words').some(span => span.italic));
    assert.ok(styled(chapter, 'mixed emphasis').some(span => span.bold && span.italic));
    assert.ok(styled(chapter, 'deleted words').some(span => span.strike));
    assert.ok(!styled(chapter, 'This paragraph').some(span => span.bold || span.italic || span.strike));
    assert.doesNotMatch(chapter.text, /\x1b/);
    const prose = chapter.paragraphs!.map(span => chapter.text.slice(span.offset, span.offset + span.length));
    assert.ok(prose.some(text => text.startsWith('Ordinary paragraph')));
    assert.ok(prose.some(text => text.startsWith('A second paragraph')));
    assert.ok(prose.every(text => !/Quoted paragraph|First list item|Nested list|Completed task|if \(ready\)|First verse/.test(text)));
    const first = new Screen(book, '', { chapter: 0, offset: 0 }); first.resize(100, 100);
    assert.equal(first.lines[0].text, 'Formatting playground');
    assert.match(strip(first.render()), /\r\n {4}Ordinary paragraph/);
    assert.match(first.render(), /\x1b\[1;3mmixed emphasis/);
    assert.match(first.render(), /\x1b\[9mdeleted words/);
    assert.doesNotMatch(cleanPassage(chapter), / {4}Ordinary paragraph/);
    for (const [index, item] of book.chapters.entries()) {
      if (!item.tables?.length) continue;
      assert.ok(styled(item, 'Bold cell').some(span => span.bold));
      assert.ok(styled(item, 'Italic cell').some(span => span.italic));
      for (const width of [120, 80, 40, 20, 5]) assertCellsSurvive(book, index, width);
      const screen = assertCellsSurvive(book, index, 120);
      const frame = strip(screen.render()).split('\r\n');
      const table = item.tables[0];
      const note = frame.flatMap(line => screen.footnoteLinks(line)).find(link => item.footnotes?.some(ref => ref.id === link.id && ref.offset >= table.offset && ref.offset < table.offset + table.length));
      assert.ok(note, 'A table footnote must be clickable');
      const image = frame.flatMap(line => screen.imageLinks(line));
      assert.ok(image.length, 'A table image must be clickable');
      const offset = item.text.indexOf('wrapping');
      const search = new BookSearch(book, 'wrapping');
      search.align({ chapter: index, offset });
      screen.go({ chapter: index, offset });
      for (const width of [100, 40, 20, 80]) {
        screen.resize(width, 200); assert.deepEqual(screen.locator, { chapter: index, offset });
        assert.match(screen.render(search.highlights(index)), /\x1b\[7mwrapping/);
      }
    }
    assert.ok(book.chapters.some(item => item.footnotes?.length));
    const image = await extractImage(bytes, { filename: `formatting.${format}`, documentPath: `${process.cwd()}/samples/formatting.${format}` }, book.images![0].id);
    assert.equal(image.width, 1); assert.equal(image.height, 1);
  });
}

void test('FB2 named inline styles keep text; XML indentation, verse, quotations and code retain their structure', async () => {
  const bytes = await readFile('samples/formatting.fb2');
  const book = readFb2(bytes), chapter = book.chapters[0];
  assert.match(chapter.text, /A named style retains nested emphasis without losing its text/);
  assert.ok(styled(chapter, 'nested emphasis').some(span => span.italic));
  assert.match(chapter.text, /First verse line\.\nSecond verse line\.\n\nNext stanza line\.\nLast verse line\.\n\nPoet name/);
  assert.match(chapter.text, /if \(ready\) \{\n  print\("literal"\);\n\}/);
  assert.match(chapter.text, /(?:^|\n)> Epigraph text/);
  assert.match(chapter.text, /(?:^|\n)> Quoted paragraph/);
  assert.ok(styled(chapter, 'Quote author').some(span => span.italic));
  assert.equal(chapter.anchors.tables, chapter.text.indexOf('Tables and references'));
  const prefixed = bytes.toString().replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, '<$1f:$2').replace('<f:FictionBook ', '<f:FictionBook xmlns:f="http://www.gribuser.ru/xml/fictionbook/2.0" ');
  assert.deepEqual(readFb2(Buffer.from(prefixed)), book, 'Namespace prefixes must not change formatting or offsets');
  for (const filename of ['formatting.fb2.zip', 'formatting.fbz']) {
    const result = await readBook(zip([['books/formatting.fb2', bytes]]), { filename });
    assert.equal(result.kind, 'book');
    if (result.kind === 'book') assert.deepEqual(result.book, book);
  }
});

void test('Markdown playground retains nested lists, tasks, literal code, Setext headings and styled notes', async () => {
  const { book } = readMarkup(await readFile('samples/formatting.md'), 'formatting.md');
  const text = book.chapters.map(chapter => chapter.text).join('');
  assert.match(text, /(?:^|\n)- First list item/);
  assert.match(text, /(?:^|\n) {2}- Nested list item/);
  assert.match(text, /(?:^|\n)3\. Third numbered item/);
  assert.match(text, /(?:^|\n)\[x\] Completed task/);
  assert.match(text, /(?:^|\n)\[ \] Pending task/);
  assert.match(text, /a  \+  b/);
  assert.match(text, /if \(ready\) \{\n  print\("\*\*literal\*\*, <em>not HTML<\/em>, \[\^not-a-note\]"\);\n\}/);
  assert.ok(book.toc.some(item => item.title === 'Setext heading'));
  const notes = book.chapters.find(chapter => chapter.text.includes('bold note'))!;
  assert.ok(styled(notes, 'bold note').some(span => span.bold));
  assert.match(notes.text, /Continued note text/);
  assert.ok(book.chapters.flatMap(chapter => chapter.footnotes ?? []).every(note => !JSON.stringify(note).includes('not-a-note')));
});

for (const format of ['html', 'epub']) {
  void test(`${format} preserves hanging list layout, definitions, captions and aligned table source mappings`, async () => {
    const source = (await readFile('samples/formatting.html')).toString();
    const book = format === 'html' ? readMarkup(Buffer.from(source), 'formatting.html').book : await readEpub(epub(/<body>([\s\S]*)<\/body>/.exec(source)![1], /<style>([\s\S]*)<\/style>/.exec(source)![1]));
    const chapter = book.chapters[0];
    const screen = new Screen(book, '', { chapter: 0, offset: 0 }); screen.resize(60, 200);
    assert.ok(styled(chapter, 'Source anchor').some(span => span.bold));
    assert.ok(styled(chapter, 'Figure caption').some(span => span.italic));
    assert.match(chapter.text, /III\. Countdown three/);
    assert.match(chapter.text, /VII\. Reset seven/);
    assert.match(chapter.text, /VI\. Countdown six/);
    assert.match(chapter.text, /\n10\. Second outer/);
    assert.match(chapter.text, /\nFigure caption/);
    for (const width of [80, 40, 20, 8, 3]) {
      screen.resize(width, 200);
      for (const block of chapter.indents ?? []) {
        const lines = screen.lines.filter(line => line.offset >= block.offset && line.offset < block.offset + block.length);
        assert.ok(lines.length);
        for (const [index, line] of lines.entries()) {
          const indent = Math.min(index ? block.continuation : block.firstLine, Math.max(0, width - 1 - 4));
          if (indent) assert.ok(line.text.startsWith(' '.repeat(indent)), `${width}: ${line.text}`);
          for (const run of line.runs ?? []) assert.equal(line.text.slice(run.startIndex, run.startIndex + run.length), chapter.text.slice(run.offset, run.offset + run.length));
        }
      }
      assertCellsSurvive(book, 0, width);
    }
    screen.resize(80, 200);
    assert.match(strip(screen.render()), /\r\n {3}Outer item resumes/);
    assert.match(strip(screen.render()), /\r\n {4}A definition/);
    const offset = chapter.text.indexOf('bold nested text');
    screen.go({ chapter: 0, offset });
    const search = new BookSearch(book, 'bold nested text'); search.align({ chapter: 0, offset });
    assert.match(screen.render(search.highlights(0)), /\x1b\[1;7mbold nested text/);
    screen.go({ chapter: 0, offset: 0 });
    assert.ok(strip(screen.render()).split('\r\n').some(line => screen.footnoteLinks(line).length));
    const tableChapter = book.chapters.findIndex(item => item.tables?.length);
    const grid = assertCellsSurvive(book, tableChapter, 100);
    const amount = book.chapters[tableChapter].tables![0].rows[2].cells[1];
    assert.equal(amount.align, 'right');
    const amountLine = grid.lines.find(line => line.runs?.some(run => run.offset === amount.offset))!;
    assert.match(amountLine.text, / +123\.45 \|/);
    assert.ok(amountLine.runs!.find(run => run.offset === amount.offset)!.startIndex > 40);
    const cards = assertCellsSurvive(book, tableChapter, 30);
    assert.ok(cards.lines.some(line => line.text === 'Measures / Amount:'));
    assert.ok(cards.lines.some(line => line.text === 'Measures / State:'));
  });
}

void test('list numbering, loose tasks and headerless table labels retain their meaning', () => {
  const { book } = readMarkup(Buffer.from('<ol start="0"><li>Zero</li><li value="-2">Negative</li><li>Next</li></ol><ol type="a" start="26"><li>Last letter</li><li>Two letters</li></ol><ul><li><p><input type="checkbox" checked>Loose task with enough words to wrap its content properly.</p></li></ul><table><tr><td>Alpha</td><td>Beta</td></tr><tr><td>Gamma</td><td>Delta</td></tr></table>'), 'a.html');
  const chapter = book.chapters[0];
  assert.match(chapter.text, /^0\. Zero/); assert.match(chapter.text, /-2\. Negative/); assert.match(chapter.text, /-1\. Next/);
  assert.match(chapter.text, /z\. Last letter/); assert.match(chapter.text, /aa\. Two letters/);
  assert.match(chapter.text, /\[x\] Loose task/);
  const screen = new Screen(book, '', { chapter: 0, offset: 0 }); screen.resize(30, 100);
  assert.ok(screen.lines.some(line => line.text === 'Column 1:'));
  assert.ok(!screen.lines.some(line => line.text === 'Alpha:'));
});

void test('large list splits retain continuation indentation without injecting it into copied source', () => {
  const { book } = readMarkup(Buffer.from('<h1>Long list</h1><ul><li>' + 'word '.repeat(30_000) + '</li></ul>'), 'large.html');
  const chunks = book.chapters.filter(chapter => chapter.text.includes('word'));
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].indents![0].firstLine, 0);
  assert.ok(chunks.slice(1).every(chapter => chapter.indents![0].firstLine === 2));
  const index = book.chapters.indexOf(chunks[1]);
  const screen = new Screen(book, '', { chapter: index, offset: 0 }); screen.resize(40, 20);
  assert.match(screen.lines[0].text, /^ {2}\S/);
  assert.doesNotMatch(cleanPassage(chunks[1]), /^ {2}/);
  const nestedHeading = readMarkup(Buffer.from('<ol><li><h2>Heading inside a list</h2><p>Item paragraph.</p></li></ol>'), 'heading.html').book;
  const headingChapter = nestedHeading.chapters.findIndex(chapter => chapter.text.startsWith('Heading inside'));
  const headingScreen = new Screen(nestedHeading, '', { chapter: headingChapter, offset: 0 });
  assert.equal(headingScreen.lines[0].text, 'Heading inside a list');
});

void test('FB2 embedded CSS styles named inline text and aligns cells without loading resources', async () => {
  const source = (await readFile('samples/formatting.fb2')).toString();
  const book = readFb2(Buffer.from(source));
  const chapter = book.chapters[0];
  assert.ok(styled(chapter, 'named style retains').some(span => span.underline));
  assert.ok(styled(chapter, 'nested emphasis').some(span => span.underline && span.italic));
  assert.ok(chapter.tables![0].rows[2].cells.every(cell => cell.align === 'right'));
  assert.doesNotMatch(chapter.text, /text-align|text-decoration/);
  const hostile = source.replace('.custom {', '@import url(https://example.com/never.css); @media print { p {display:none} } .custom {');
  assert.deepEqual(readFb2(Buffer.from(hostile)), book);
  for (const width of [100, 40, 20]) assertCellsSurvive(book, 0, width);
});

void test('TXT chapter recognition adds styled contents without changing source, chunks, copy text or locators', async () => {
  const source = await readFile('samples/formatting.txt');
  const enabled = readTxt(source, 'formatting.txt'), disabled = readTxt(source, 'formatting.txt', 'utf-8', false);
  assert.deepEqual(enabled.chapters.map(chapter => chapter.text), disabled.chapters.map(chapter => chapter.text));
  assert.deepEqual(enabled.toc.map(item => [item.title, item.depth]), [['Part I', 0], ['Chapter 1 — Beginning', 1], ['Chapter 2', 1], ['Часть II', 0], ['Глава 3 — Продолжение', 1], ['Эпилог', 0]]);
  assert.equal(disabled.toc.length, 1); assert.equal(disabled.chapters[0].styles, undefined);
  assert.equal(cleanPassage(enabled.chapters[0]), source.toString());
  for (const item of enabled.toc) assert.equal(enabled.chapters[item.chapter].text.slice(item.offset, item.offset + item.title.length), item.title);
  const screen = new Screen(enabled, '', { chapter: 0, offset: 0 }); screen.resize(80, 100);
  assert.match(screen.render(), /\x1b\[1;4mChapter 1/);
  const falsePositives = 'A sentence\nChapter 2 is mentioned here.\nMore text\n\n1. Numbered item\n\nMIX\n\n    diagram\n\nChapter\n1\n\nSplit line is not a heading.\n';
  assert.equal(readTxt(Buffer.from(falsePositives), 'a.txt').chapters[0].styles, undefined);
  const large = Buffer.from('word '.repeat(14_000) + '\n\nChapter 7\n\nBody.');
  const book = readTxt(large, 'large.txt');
  assert.equal(book.chapters.map(chapter => chapter.text).join(''), large.toString());
  assert.ok(book.toc[0].chapter > 0); assert.equal(book.toc[0].title, 'Chapter 7');
  const result = await readBook(source, { filename: 'a.txt', txtDetectHeadings: false });
  assert.equal(result.kind, 'book'); if (result.kind === 'book') assert.equal(result.book.chapters[0].styles, undefined);
});
