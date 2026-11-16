# Formatting playground

Ordinary paragraph with **bold words**, *italic words*, ***mixed emphasis*** and ~~deleted words~~. This paragraph is deliberately long enough to wrap across several visual lines on narrow terminals. Привет, 中文, 👩‍💻.

A second paragraph keeps its own first-line indent.

## Lists and code

- First list item with **bold list text**.
  - Nested list item.
- Second list item.

3. Third numbered item.
4. Fourth numbered item.

- [x] Completed task.
- [ ] Pending task.

> Quoted paragraph with *italic quote*.
>
> Another quoted paragraph.

Inline code: `a  +  b`.

```ts
if (ready) {
  print("**literal**, <em>not HTML</em>, [^not-a-note]");
}
```

## Tables and references

| Name | Value | Reference |
| --- | --- | --- |
| 中文 👩‍💻 | **Bold cell** with many words to exercise wrapping without losing content. | Footnote[^one] |
| Second | *Italic cell* | ![Pixel](formatting.png) |
| Empty | | Last cell |

Footnote reference outside the table[^one]. An [external link](https://example.com) keeps its label.

[^one]: Note body with **bold note**.
    Continued note text.

Setext heading
==============

Final paragraph.
