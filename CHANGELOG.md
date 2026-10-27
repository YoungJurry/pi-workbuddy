# Changelog

## 0.1.3

- Preserve complete upstream HTTP error bodies, including WorkBuddy's business codes, localized messages/tips, request IDs, and extra fields, instead of redacting them.
- Surface SSE error data and HTTP 200 JSON business errors in Pi's final assistant error message.
- Retain official errors from login, token refresh, catalog refresh, and status diagnostics.
- Keep endpoint/account validation, redirect restrictions, request privacy headers, retry metadata, cancellation, and resource/output limits unchanged.
- Add offline regressions for permission/rate-limit responses, plain text/HTML, long errors, fragmented and mid-stream errors, and actual Pi host error propagation.
- Document that upstream error bodies are no longer redacted and may contain sensitive data echoed by the service.

## 0.1.2

- Refresh the catalog in the background during interactive startup, using the cached/fallback models immediately instead of blocking entry into the session.
- Cancel pending startup refreshes on session shutdown/replacement and ignore late results when recovering the selected model.
- Preserve foreground discovery for headless startup and the explicit `/workbuddy refresh` command, plus cache-only behavior under `PI_OFFLINE`.
- Add regressions for pending discovery, model-selection races, cancellation, and detached errors; retain the existing request timeout and sanitized failures.

## 0.1.1

- Align client-identification headers with the statically inspected WorkBuddy AI 5.8.4 desktop baseline.
- Remove `pi-workbuddy/<version>`, `X-IDE-Type: pi` and the plugin version from upstream client identity.
- Share one identity profile across login, refresh, catalog, auth and chat paths.
- Keep the native Provider, startup-only global event, account data and request content unchanged.
- Add offline regressions for header overrides, account preservation, both gzip modes and correlation IDs.
- Document primary-source provenance and the distinction between local extension version and wire client version.

## 0.1.0

- Initial native WorkBuddy AI international provider.
- Session-start catalog refresh with no per-turn/UI hooks, CLI, proxy or credit reader.
