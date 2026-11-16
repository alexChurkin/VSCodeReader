# Sample books / Тестовые книги

`formatting.md` and `formatting.fb2` are original synthetic books for both manual
and automated formatting checks. Open either with **VSCodeReader: Open Book**.
They cover headings, nested emphasis, strike-through, prose indentation,
quotations, code, Unicode, tables, images and footnotes. Markdown additionally
exercises nested/ordered/task lists and Setext headings; FB2 exercises epigraphs,
named inline styles, verse/stanza breaks and merged/empty cells.
`formatting.png` is a generated one-pixel image used by Markdown and embedded
in FB2. Try widths of 120, 80, 40 and 20 columns: tables switch from grids to row
cards. Ctrl+click images/footnotes, return with `u`, and verify search/copy after
resizing. Run `node --import tsx test/formatting.test.ts` for automated checks.

`formatting.md` и `formatting.fb2` — собственные синтетические книги для ручных
и автоматических проверок. Открывайте их через **VSCodeReader: Open Book**.
Проверяются заголовки, вложенные выделения, зачёркивание, абзацы, цитаты, код,
Unicode, таблицы, картинки и сноски. В Markdown дополнительно есть списки,
задачи и заголовки Setext; в FB2 — эпиграфы, именованные inline-стили, стихи со
строфами, объединённые и пустые ячейки. `formatting.png` — сгенерированная
картинка 1×1, встроенная также в FB2. Проверьте ширины 120, 80, 40 и 20 колонок,
Ctrl+клик по картинкам/сноскам, возврат через `u`, поиск и копирование.

All samples are excluded from the VSIX. / Все примеры исключены из VSIX.

## EPUB

`alice-in-wonderland.epub` — Lewis Carroll, *Alice’s Adventures in Wonderland*, иллюстрации John Tenniel. Project Gutenberg, eBook № 11.

- Страница источника: <https://www.gutenberg.org/ebooks/11>.
- Адрес загрузки: <https://www.gutenberg.org/ebooks/11.epub3.images>.
- Дата загрузки: 2026-11-15.
- Формат: EPUB, package version `3.0`, с иллюстрациями.
- Размер: 189249 байт.
- SHA-256: `4f81245d31380ac1d6eafb9a321e3691369bc70985736ae4bccf849a4f784036`.

Файл сохранён без изменений. ZIP проверен на целостность, `mimetype` — `application/epub+zip`; container.xml указывает на корректный XML package document.

Источник указывает статус public domain в США. Уведомления и условия Project Gutenberg сохранены внутри EPUB; перед дальнейшим распространением необходимо учитывать эти условия и права в соответствующей юрисдикции. Лицензия будущего кода расширения не заменяет условия использования этой книги.

Пример предназначен для ручной проверки глав, оглавления, изображений, оформления и восстановления позиции. CI использует небольшие собственные fixtures без сетевой загрузки.
