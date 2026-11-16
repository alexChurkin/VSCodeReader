import { performance } from 'node:perf_hooks';
import { Screen } from '../src/screen.ts';

for (const [name, paragraph] of [['ascii', 'A long paragraph with ordinary words and spaces. '], ['unicode', 'Длинная строка с обычными словами, 中文 и emoji 👩‍💻. ']]) {
  const text = paragraph.repeat(6000);
  const book = { title: 'Benchmark', author: '', chapters: [{ id: 'one', title: 'One', text, anchors: {} }], toc: [] };
  const start = performance.now();
  const screen = new Screen(book, '', { chapter: 0, offset: 0 });
  const wrapped = performance.now();
  for (let jump = 0; jump < 1000; jump++) screen.go({ chapter: 0, offset: (jump * 997) % text.length });
  const jumped = performance.now();
  for (let frame = 0; frame < 100; frame++) screen.render();
  console.log(JSON.stringify({ name, characters: text.length, lines: screen.lines.length, firstWrapMs: +(wrapped - start).toFixed(2), thousandJumpsMs: +(jumped - wrapped).toFixed(2), hundredFramesMs: +(performance.now() - jumped).toFixed(2) }));
}
