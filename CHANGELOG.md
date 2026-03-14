# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-03-14

### Added

- `tool_result` event handler: redacts sensitive strings from tool output (file
  reads, command output) before they enter the LLM context. Fail-closed on error
  and replaces the result with a static error string.
- `context` event handler: scans the full message history before each LLM call.
  Redacts secrets in string content, array content blocks, and unsigned thinking
  blocks. Fail-closed on error and returns empty messages.
- `redactContent()` method on `RedactorConfig` for redacting `ContentBlock[]`
  arrays. Text blocks are scanned and image blocks pass through unchanged.
  `textSignature` is stripped from modified blocks to invalidate stale
  signatures.
- `ContentBlock` type union and `ContentRedactionResult` interface in `core.ts`.
- `extractErrorReason()` helper in `index.ts` to deduplicate error-formatting
  logic across handlers.
- Integration test suite (`test/index.test.ts`) covering fail-closed behavior,
  content redaction, and thinking-block handling for the extension entry point.

### Changed

- Documentation (`README.md`, `AGENTS.md`) updated to reflect the three-point
  interception model (`input`, `tool_result`, `context`) and new limitations
  (signed thinking blocks, `toolCall` arguments, TOCTOU window).

### Fixed

- Stale `lastKnownConfigVersion` after config recovery. `loadConfig()` now
  resets the cached version to `null` on non-envelope and checksum-mismatch
  recovery paths, preventing a `SaveFailedError` on the subsequent save.
- `onConfigChange` firing before save in the confirm flow. `interpretEffects()`
  now defers the callback until all child effects (including the atomic write)
  succeed, keeping in-memory config consistent with on-disk state when save
  fails.

### Security

- Dynamic error details (e.g., contract-violation conditions) are no longer
  included in the LLM-visible `tool_result` error content. The fail-closed path
  returns a static `"[REDACTED — internal redaction error]"` string. The
  detailed reason is shown only via the local `notify()` UI channel.

## [1.0.0] - 2026-03-12

### Added

- `/redact add <string>` command to register a pattern that replaces the
  original string with `[REDACTED]`.
- `/redact add <string> as <label>` command to register a pattern with a
  custom replacement label. The last occurrence of ` as ` is used as the
  delimiter.
- `/redact remove <string>` command to delete a pattern by its original string.
- `/redact list` command to display all active patterns.
- `/redact clear` command to remove all patterns with a confirmation prompt.
- `/redact on` and `/redact off` commands to toggle redaction at runtime.
- `/redact limit <n>` command to set the maximum number of allowed patterns
  (default 100, ceiling 1000).
- `/redact` command (no arguments) to display help and usage.
- Single-pass regex redaction with longest-match-first semantics via a combined
  alternation regex. All patterns are applied in one pass; results are
  deterministic regardless of insertion order.
- Case-insensitive matching for all patterns.
- Fail-closed behavior: if redaction fails at runtime, the message is blocked
  from reaching the LLM. The original text is never sent unredacted.
- Status bar integration showing pattern count, or `off` when disabled.
- Notification on each redacted message showing the number of replacements.
- Persistent configuration stored in a platform-specific state directory
  (`~/.local/state/pi-redactor/config.json` on Linux/macOS,
  `%LOCALAPPDATA%\pi-redactor\config.json` on Windows). Respects
  `XDG_STATE_HOME`.
- SHA-256 checksum in the config envelope for tamper detection. A mismatch
  disables the redactor and warns the user.
- `maxPatterns` field in the config envelope `data` payload, persisting the
  user-configured pattern limit across sessions.
- Optimistic concurrency control via a `configVersion` counter. Concurrent
  sessions that modify the config file trigger a save error with instructions
  to reload.
- Atomic writes (write-to-temp then rename) to prevent config corruption from
  interrupted writes.
- Degraded-config recovery: corrupted or unreadable config files cause the
  redactor to start disabled with a warning. The user must review and
  explicitly re-enable.
- Stale pattern warnings at session start for patterns older than 90 days.
- Default limit of 100 patterns, configurable up to 1000 via `/redact limit <n>`.
  Adding a pattern beyond the current limit produces an error.
- Maximum of 1000 characters per pattern (original and replacement).
- Validation that a replacement string does not contain its own original
  (prevents infinite expansion).
- Contract enforcement via precondition, postcondition, and invariant checks
  (`ContractViolation` error type).
- Malformed patterns in the config file are skipped and reported as warnings
  rather than silently dropped.
- `session_start` event handler that loads config, surfaces warnings, and
  initializes the status bar.
- `input` event handler that intercepts messages before they reach the LLM
  provider.

[unreleased]: https://github.com/nrednav/pi-redactor/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/nrednav/pi-redactor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrednav/pi-redactor/releases/tag/v1.0.0
