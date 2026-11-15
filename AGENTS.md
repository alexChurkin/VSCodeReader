# Repository conventions

- Keep the extension version at `0.1.0` in package.json and both root entries of package-lock.json. The user explicitly wants one continuously updated version; do not bump it.
- Produce only `vscode-reader-0.1.0.vsix`. Replace that artifact on each build and remove obsolete project VSIX files. Use `npm run package`, which enforces this policy.
- Describe current functionality. Do not create release-history documents, historical changelog entries or references to superseded project versions.
- Keep README.md in English as the primary README, and maintain its Russian translation in README.ru.md.
- Preserve the terminal reading interface and the book icon / Library sidebar. PDF support is deferred at the user's request.
- Name terminal tabs after the book by default and preserve the dim contextual footer. Closing a PTY must acknowledge exit and release the session; trash and `q` should work immediately.
