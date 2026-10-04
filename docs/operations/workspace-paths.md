# Workspace file paths

File operations use the sandbox namespace, independent of the host OS. Use a workspace-relative path such as `src/app.ts`, the explicit `@/src/app.ts` shortcut, or a canonical absolute path such as `/workspace/src/app.ts`. Literal `@scope` directories are preserved. Windows separators and absolute drive-prefixed representations are accepted only when the resulting path remains inside the configured root. Local `file:///` URIs support percent-encoded filenames; remote authorities, UNC paths, home expansion, drive-relative paths, and traversal outside the workspace are refused.

This intentionally tightens PR #22: `/src/app.ts` and `C:\src\app.ts` are outside-root absolute paths, not shorthand for files inside `/workspace`. Callers should use relative paths or the actual sandbox absolute path. Read selectors remain separate from path resolution. Hashline headers and move destinations reach the same resolver without host path interpretation. Both sandbox adapters apply it to reads, writes, append, metadata, listing, copy, move, deletion, and directory operations; sandbox-side symlink denial remains in place. Shell command strings retain normal shell semantics.

No database migration, new dependency, or environment variable is required. Deploy rebuilt CTO runtime, API, and worker artifacts together so the exported resolver is present. Rollback restores the previous artifacts, including their path behavior; this change does not modify persisted source or checkpoint formats.

## Verification

- Frozen lockfile installation passed.
- Focused CTO runtime tests: 93 passed across path resolution, real tool read/edit/write sequences, hashline and legacy Node read regressions.
- API sandbox filesystem tests: 4 passed using real Node filesystem processes.
- Worker Docker edit integration: 1 passed, including literal `@` targets, adapter operations, outside-root denial, and asserted container/volume teardown.
- CTO runtime and worker production builds passed.
- Repository formatting/lint passed (307 files); CTO runtime, API, and worker type checks passed. Full repository tests/build and deployment checks remain PR CI gates. No live user run, server, preview, or TTS process was changed.
