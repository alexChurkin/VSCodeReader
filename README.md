# VSCodeReader

**English** · [Русский](README.ru.md)

Read books in VS Code in a tab that looks like console output. VSCodeReader uses a real **Terminal** tab named `output`, your terminal font and colors, and keyboard navigation. Illustrations open on demand in separate editor tabs.

The current **0.1.0** build supports EPUB, FictionBook, plain text, CBZ comics, HTML and Markdown. [Implementation plan (Russian)](docs/IMPLEMENTATION_PLAN.md) · [Architecture decisions (Russian)](docs/ADR-001-terminal-reader.md).

## Supported formats

| Format | Support |
| --- | --- |
| EPUB 2 / EPUB 3 (`.epub`) | Reflowable text, spine order, nav/NCX table of contents, embedded raster images |
| FictionBook 2 (`.fb2`) | Metadata, nested sections, poems, notes as sections, embedded base64 images; XML-declared encodings including Windows-1251 |
| FB2.ZIP / FBZ (`.fb2.zip`, `.fbz`) | One or multiple FB2 books; choose an entry when an archive contains several books |
| Plain text (`.txt`) | UTF-8, UTF-16 BOM and configurable Windows-1251; long files split into navigable parts |
| HTML (`.html`, `.htm`) | Headings as chapters, document title/author, text, lists, code blocks and local or base64 images |
| Markdown (`.md`, `.markdown`) | ATX/Setext headings, GFM lists/tasks/tables, fenced code and images |
| Comic Book ZIP (`.cbz`) | Raster pages in natural filename order (`page2` before `page10`); open the current page with `i` |

Ordinary `.zip` files are not treated as books. PDF and MOBI/AZW3 are not supported. EPUB fixed layout, DRM, multimedia and inline footnote navigation remain outside this version.

## Get started

1. Install `vscode-reader-0.1.0.vsix` using **Extensions: Install from VSIX…**.
2. Click the **book icon** in the left Activity Bar to open **Reader → Library**.
3. Click **Open book…** and choose a supported file. Click **Continue reading** to resume later.

The version stays at **0.1.0**; each package build replaces `vscode-reader-0.1.0.vsix` and removes obsolete project VSIX files.

To build the VSIX locally, use `npm ci` and `npm run package` (Node.js 22). For development, press F5 (`Run VSCodeReader`). Requires VS Code 1.95.0 or later. An [Alice EPUB sample](samples/README.md) is included for testing.

The terminal is called `output` to keep its console appearance. The sidebar shows the actual book title. Change `vscodeReader.terminalName` if you prefer another terminal name.

Supported files also have an **Open Book** action in the Explorer context menu. Opening the same book again reuses its reading session. Entries in a multi-book FB2 archive have separate sessions and reading positions.

## Keyboard controls

With focus in the reader terminal:

| Keys | Action |
| --- | --- |
| `j` / `k`, ↓ / ↑ | Next / previous line |
| Space / PageDown, PageUp | Next / previous screen, crossing chapters |
| `n` / `p` | Next / previous chapter or comic page |
| `g` | Table of contents |
| `/` | Search the book, up to 200 matches |
| `b` | Save a quick bookmark (with confirmation) |
| `B` | Go to a bookmark |
| `s` | Show chapter, screen, location and percentage |
| `l` | Jump to a location number or percentage |
| `i` | Open the current illustration, or choose one if there are several |
| `?` | Keyboard help |
| Escape | Clear the text and show `ready` |

**VSCodeReader: Resume Reading** restores hidden text or reopens the last book after closing the terminal or restarting VS Code. **VSCodeReader: Hide Text** hides the active reading session from the Command Palette. After Escape, use Resume Reading to bring the text back.

## Progress and bookmarks

The **Library** sidebar shows the current book, chapter, screen, text location and percentage. Click the progress row to jump, or press `l` and enter a location such as `12` or a percentage such as `40%`.

Screens are sized to the terminal and change when you resize it. Text locations are fixed units of roughly 1,000 characters across the book, so they stay stable across changes in width and font size. These are reading locations, not printed page numbers. The exact passage is saved automatically during navigation, on hide/close, and at shutdown; repeated resizing preserves the original text anchor.

Press `b` for a quick bookmark, or click **Add bookmark…** in the sidebar to give it a name. Saved bookmarks appear in **Bookmarks**. Click one to return to its passage; use the pencil and trash buttons to rename or delete it. **Recent books** remembers the last ten books, and **Open books** lets you switch between active sessions.

Position and bookmark data stay local. Changing the source file starts a new reading position. Book contents are not sent over the network.

## Images and comics

The terminal shows text markers instead of inline images. Press `i` to open an illustration in a separate editor tab. When the current chapter has one image, it opens directly; otherwise a picker lists the book's images with current-chapter images first. **VSCodeReader: Open Image** lists all available images, including covers. The terminal keeps keyboard focus so you can continue navigating.

EPUB archive images, FB2 base64 images and HTML/Markdown illustrations are loaded only when requested. PNG, JPEG, GIF, WebP and BMP are supported. SVG and remote images are not opened. Images are limited to 10 MiB, 40 megapixels and 16,384 pixels per side. A bounded local preview cache holds at most 128 files / 100 MiB; old previews may need to be reopened from the book after eviction.

For HTML/Markdown, image paths are resolved relative to the document folder. Images must stay inside that folder, including after resolving symlinks. Absolute paths, parent-directory escapes and remote URLs are not opened; HTML `<base>` and `srcset` are not used. Raster `data:image/...;base64,...` images are also supported. Original HTML/Markdown files still open in the normal VS Code editor; use Open Book for reading mode.

For CBZ, use `n` / `p` to select a page and `i` to open it. Pages stay in separate image tabs; page changes do not automatically open images. If the book changes on disk, close its reading terminal and reopen it before viewing more images.

## Settings

- Font, font size and colors: use normal VS Code terminal settings.
- `vscodeReader.terminalName`: tab name; defaults to `output`.
- `vscodeReader.linePrefix`: optional prefix such as `[text] `; empty by default.
- `vscodeReader.textEncoding`: `utf-8` (default) or `windows-1251` for TXT, HTML and Markdown without a BOM or HTML charset declaration. BOM takes precedence; HTML also honors its meta charset and FB2 follows its XML encoding declaration.

Reader settings apply to new sessions. Close and reopen a book to change its text encoding. Book titles, covers and progress indicators are not constantly displayed in the terminal.

## Development and checks

```sh
npm run check        # typecheck, unit tests, extension and parser worker build
npm run test:host    # integration checks in VS Code 1.95.3
npm run package      # VSIX without samples, tests or node_modules
```

The host test runs VS Code twice to verify that positions and named bookmarks survive a full restart. It downloads VS Code on its first run. Linux needs Electron libraries and a display (`xvfb-run` in CI). Set `VSCODE_TEST_VERSION` to test another VS Code version. Tests use synthetic books and the included EPUB; they do not download books.

Parsing and image extraction run in cancellable workers. Limits: 100 MiB input, 300 MiB declared archive contents, 10,000 archive entries, 10 MiB per extracted resource, and 32 MiB of extracted text. Uncompressed FB2/TXT/HTML/Markdown documents are limited to 32 MiB; a compressed FB2 entry is limited to 10 MiB.

Book scripts and terminal control sequences are not executed. HTML is converted to text; CSS, forms and dynamic page content are not rendered. Markdown links retain their labels, without interactive navigation. Rich HTML layout, lazy chapter loading, interactive footnotes and expanded accessibility are still planned. The project's own license has not been selected (`UNLICENSED`); dependency notices are included in the VSIX.
