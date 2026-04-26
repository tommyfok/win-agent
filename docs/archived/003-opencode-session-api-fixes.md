# OpenCode Session API Fixes

## Context

OpenCode SDK session responses use the generated OpenAPI shape:

- `session.messages()` returns `{ info: Message, parts: Part[] }[]`.
- `Session` timestamps live under `time.created` / `time.updated`, not `createdAt` / `updatedAt`.
- `session.status()` returns a map of session ID to `{ type: "idle" | "busy" | "retry" }`.
- `session.promptAsync()` returns `204 void`, meaning accepted, not completed.

## Fix Plan

1. Fix readiness polling to inspect `message.info.role` instead of a non-existent top-level `role`.
2. Add an aborting timeout helper so timed-out SDK calls cancel the underlying HTTP request.
3. Use the aborting helper for `session.prompt()` and async bind/resume prompts.
4. Persist DEV task session mappings after context rotation.
5. Add focused tests for readiness polling, abort signal propagation, and DEV rotation persistence.
