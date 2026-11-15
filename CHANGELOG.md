# Changelog

## 0.0.3 — 2026-11-15

- Add HTML/HTM and Markdown (.md/.markdown) reading through Open Book and Explorer.
- Build sections and table of contents from visible headings; preserve code whitespace, lists, tasks and table cells.
- Open local images within the document folder and embedded raster data URLs on demand.
- Honor HTML charset declarations and configurable text encoding; keep normal VS Code editors as defaults.
- Bound long sections and local image reads; reject remote resources, path escapes and symlinks outside the document folder.

## 0.0.2 — 2026-11-15

- Add FB2 metadata, nested sections, notes, poems and XML-declared encodings.
- Add FB2.ZIP / FBZ with book selection and separate reading positions per archive entry.
- Add TXT with UTF-8, UTF-16 BOM and configurable Windows-1251.
- Add CBZ comics with natural page ordering.
- Open embedded EPUB / FB2 images and CBZ pages in native image editor tabs using `i` or Open Image.
- Add bounded image preview cache, byte/dimension validation and on-demand worker extraction.
- Make English the primary README and add a linked Russian translation.

## 0.0.1 — 2026-11-15

- Первый EPUB-прототип в настоящей вкладке Terminal.
- Оглавление EPUB 3 nav / EPUB 2 NCX, поиск, закладки, сохранение позиции.
- Переносы Unicode, навигация с клавиатуры, очистка текста по Escape.
- Разбор в отменяемом worker, ограничения архивов и фильтрация терминальных управляющих символов.
