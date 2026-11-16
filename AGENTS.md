# Repository conventions

- Keep the extension version at `0.1.0` in package.json and both root entries of package-lock.json. The extension version stays fixed for now; the code revision must update automatically in every release title. Do not bump the extension version.
- Produce only `vscode-reader-0.1.0.vsix`. Replace that artifact on each build and remove obsolete project VSIX files. Use `npm run package`, which enforces this policy.
- Describe current functionality. Do not create release-history documents, historical changelog entries or references to superseded project versions.
- Keep README.md in English as the primary README, and maintain its Russian translation in README.ru.md.
- Preserve the terminal reading interface and the book icon / Library sidebar. PDF support is deferred at the user's request.
- Name terminal tabs after the book by default and preserve the dim contextual footer. Closing a PTY must acknowledge exit and release the session; trash and `q` should work immediately.
- Keep the current page, total pages and percentage visible in the bottom reading bar; page status takes priority over hints and notifications on narrow terminals.
- Publish the installer as the single GitHub Release `v0.1.0` after successful main builds, replacing the VSIX and checksum assets. Do not treat a local VSIX or an Actions artifact alone as the release.
- Include the current 12-character Git commit SHA in the GitHub Release title (for example `VSCodeReader 0.1.0 · code abc123def456`) and link the full commit in its description. Keep the stable download URL.
- `npm run check` must include ESLint with zero warnings, strict TypeScript checks, unit tests and the production build. Fix lint findings rather than disabling rules across the project.
- Keep terminal image links scoped to their own reader and image references. Hidden/closed readers and stale frames must not open images; preserve the keyboard image picker and the native image editor tabs.
- Personal notes/annotations are deferred. Preserve source-book footnotes, per-session jump history, per-book saved search queries, and live reading layout settings without moving text anchors.
- Preserve wheel/trackpad scrolling and terminal selection mode. Clean copying must keep source paragraphs/indentation and remove parser-owned image markers without deleting literal book text.
- Keep installed Git revision metadata in the extension and VSIX, distinguish dirty development builds, and expose the latest release link in Library. Cache layout work with bounded retention; preserve graphemes and text anchors.
- Preserve semantic heading/emphasis styles and adaptive table layouts in EPUB/HTML/Markdown/FB2. FB2 named inline styles must retain text; preserve emphasis/strikethrough, verse lines and stanza breaks. Keep ANSI escapes in the renderer, maintain source mappings for table cells, and never commit private debug books; use synthetic fixtures and optional READER_DEBUG_EPUB tests.
- Keep headings flush left. Add display-only first-line indentation to ordinary prose paragraphs, excluding lists/hanging items, table cells, quotes, code, poetry, captions and contents; continuation lines and copied source text must not acquire that indent.

- List/definition continuation indents and table alignment are display-only; retain their source runs through nested lists, artificial chapter splits, search, copy and link hit testing. TXT heading detection must be switchable and must never change source text, chapter chunk boundaries or persisted locators.
