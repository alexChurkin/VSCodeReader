import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBook, extractImage, supportedBook } from '../src/formats';
import { readMarkup, localImagePath } from '../src/markup';
import { readLocalImage } from '../src/local-images';
import { png } from './fixtures';

const asText = (book: ReturnType<typeof readMarkup>['book']) => book.chapters.map(c => c.text).join('');

void test('HTML title, author, headings, entities, nested TOC and inert content', async () => {
  const source = '<!DOCTYPE html><html><head><title>A &amp; B</title><meta name="author" content="Writer"><style>evil-style</style></head><body><p>Preface</p><h1 id="a">Main</h1><p>Text &amp; entities.<br>Next line.</p><h2>Child</h2><p>Child text</p><h3 hidden>Hidden</h3><p hidden>secret</p><script>evil-script</script><template>evil-template</template><iframe>evil-frame</iframe></body></html>';
  const result = await readBook(Buffer.from(source), { filename: 'test.HTML' });
  assert.equal(result.kind, 'book'); if (result.kind !== 'book') return;
  const book = result.book;
  assert.equal(book.title, 'A & B'); assert.equal(book.author, 'Writer');
  assert.deepEqual(book.toc.map(t => [t.title, t.depth]), [['Main', 0], ['Child', 1]]);
  assert.equal(book.chapters.length, 3);
  assert.match(asText(book), /Text & entities\.\nNext line/);
  assert.doesNotMatch(asText(book), /evil-|secret|Hidden/);
  assert.equal(book.chapters[book.toc[0].chapter].anchors.a, 0);
  assert.equal(supportedBook('test.HTM'), true);
});
void test('Markdown ATX and Setext headings, fenced code, lists, tasks and tables', async () => {
  const source = '# First\n\nRead **bold** and [link](https://example.com).\n\n## Code\n\n```ts\nif (x) {\n  console.log("<script>literal</script>");\n}\n```\n\n- item one\n- item two\n\n3. third\n4. fourth\n\n- [x] finished\n- [ ] pending\n\n| Name | Value |\n| --- | --- |\n| alpha | beta |\n\nLast\n====\n\nThe end.';
  const result = await readBook(Buffer.from(source), { filename: 'test.markdown' });
  assert.equal(result.kind, 'book'); if (result.kind !== 'book') return;
  const book = result.book, text = asText(book);
  assert.equal(book.title, 'First');
  assert.deepEqual(book.toc.map(t => [t.title, t.depth]), [['First', 0], ['Code', 1], ['Last', 0]]);
  assert.match(text, /Read bold and link/);
  assert.match(text, /if \(x\) \{\n  console\.log\("<script>literal<\/script>"\);\n\}/);
  assert.match(text, /- item one/); assert.match(text, /3\. third/);
  assert.match(text, /\[x\] finished/); assert.match(text, /\[ \] pending/);
  assert.match(text, /Name \| Value \|/); assert.match(text, /alpha \| beta \|/);
  assert.doesNotMatch(text, /\*\*bold\*\*/);
});
void test('Markup encoding: HTML meta charset, configurable Markdown, BOM priority', () => {
  const hello = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  const html = Buffer.concat([Buffer.from('<meta charset="windows-1251"><h1>'), hello, Buffer.from('</h1>')]);
  assert.equal(readMarkup(html, 'ru.html').book.title, 'Привет');
  const legacy = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><p>'), hello, Buffer.from('</p>')]);
  assert.match(asText(readMarkup(legacy, 'legacy.htm').book), /Привет/);
  assert.equal(readMarkup(Buffer.concat([Buffer.from('# '), hello]), 'ru.md', 'windows-1251').book.title, 'Привет');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Текст', 'utf16le')]);
  assert.equal(readMarkup(utf16, 'utf16.md').book.title, 'Текст');
});
void test('Local and embedded images are mapped to the correct section; remote and SVG are inert', async () => {
  const data = `data:image/png;base64,${png.toString('base64')}`;
  const source = `# One\n\n![Local](assets/pic.png)\n\n## Two\n\n![Inline](${data})\n\n![Again](assets/pic.png)\n\n![Remote](https://example.com/tracker.png)\n\n![SVG](assets/active.svg)`;
  const options = { filename: 'test.md' };
  const { book, resources } = readMarkup(Buffer.from(source), options.filename);
  assert.equal(book.images?.length, 2);
  assert.deepEqual(book.images?.[0].chapters, [0, 1]); assert.deepEqual(book.images?.[1].chapters, [1]);
  assert.equal(resources.get(book.images![0].id), 'assets/pic.png');
  const embedded = await extractImage(Buffer.from(source), options, book.images![1].id);
  assert.deepEqual(Buffer.from(embedded.bytes), png);
  await assert.rejects(extractImage(Buffer.from(source), options, 'https://example.com/tracker.png'), /not part/);
  await assert.rejects(extractImage(Buffer.from(source), options, book.images![0].id), /file system/);
  const invalid = Buffer.from('![Bad](data:image/png;base64,%%%)');
  await assert.rejects(extractImage(invalid, options, 'image-0'), /base64/);
});
void test('Image paths reject traversal, schemes, absolute paths, controls and encoded separators', () => {
  for (const path of ['../secret.png', '%2e%2e/secret.png', '/secret.png', '//example.com/a.png', 'C:/secret.png', 'file:///a.png', 'https://example.com/a.png', 'javascript:evil', 'assets\\a.png', '%5c%5cserver/a.png', 'assets/a.png%00', 'foo%3Abar.png']) assert.throws(() => localImagePath(path), path);
  assert.equal(localImagePath('./assets/picture%20one.png?query#fragment'), 'assets/picture one.png');
  assert.equal(localImagePath('assets/../picture.png'), 'picture.png');
});
void test('Local images load only from real files within the document folder, including symlink checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-markup-'));
  try {
    const folder = join(root, 'book'); await mkdir(join(folder, 'assets'), { recursive: true });
    const document = join(folder, 'test.html'); await writeFile(document, '<h1>Test</h1><img src="assets/image.png">');
    await writeFile(join(folder, 'assets', 'image.png'), png);
    await writeFile(join(root, 'outside.png'), png);
    const image = await readLocalImage(document, 'assets/image.png'); assert.deepEqual(Buffer.from(image.bytes), png);
    if (process.platform !== 'win32') {
      await symlink(join(root, 'outside.png'), join(folder, 'escape.png'));
      await assert.rejects(readLocalImage(document, 'escape.png'), /outside/);
      await symlink(join(folder, 'assets', 'image.png'), join(folder, 'inside.png'));
      assert.equal((await readLocalImage(document, 'inside.png')).width, 1);
    }
    await assert.rejects(readLocalImage(document, 'assets'), /regular file/);
    const source = Buffer.from('<h1>Test</h1><img src="assets/image.png">');
    const options = { filename: 'test.html', documentPath: document };
    const result = await extractImage(source, options, 'image-0'); assert.equal(result.width, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
void test('Huge unheaded sections are split, headings in code stay literal, controls stay inert', () => {
  const source = `<pre># not a heading\n  indentation</pre><p>${'word '.repeat(30_000)}</p>`;
  const { book } = readMarkup(Buffer.from(source), 'long.html');
  assert.ok(book.chapters.length > 1); assert.ok(book.chapters.every(c => c.text.length <= 64_000));
  assert.match(asText(book), /# not a heading\n  indentation/);
  assert.ok(book.toc.every(t => !t.title.includes('not a heading')));
  assert.doesNotMatch(asText(readMarkup(Buffer.from('# Heading\n\n\x1b]52;test\x07'), 'safe.md').book), /\x1b|\x07/);
  assert.throws(() => readMarkup(Buffer.from('<script>only script</script>'), 'empty.html'), /no readable text/);
});
