# Changelog

## 0.2.3

- Delegate interactive startup model discovery entirely to Pi's native global catalog refresh. The extension's `session_start` handler returns immediately in TUI mode without auth checks, a controller, or duplicate catalog requests.
- Remove the extension-owned detached interactive refresh path. Keep the existing shared lifecycle pair only as a foreground fallback/cancellation path for headless, RPC and SDK callers that bind extension lifecycle events; no new hooks, timers or background workers.
- Preserve native cache restoration, first online unforced discovery, explicit regional force-refresh commands, account isolation and obsolete-publication guards.
- Interactive discovery updates the host catalog without extension-driven model switching; select a real model with `/model` if the current selection is a first-run fallback placeholder.
- Test real coding-agent global discovery with missing/obsolete/valid caches and one successful request per region, retain superseded-request regressions, and verify headless waiting/cancellation and zero interactive startup requests.

## 0.2.2

- Let an allowed, unforced host refresh complete the first online discovery for the current provider instance/account. Pi's interactive startup refresh can supersede the extension's forced session-start request; the replacement now fetches instead of leaving only cached/fallback models.
- Keep disk-cache restoration immediate, but do not count it as a successful online discovery. After a remote catalog is successfully published, ordinary unforced refreshes stay local; explicit force refreshes still fetch.
- Ignore diagnostics from aborted obsolete requests so they cannot overwrite a replacement's successful state.
- Retain exactly the existing shared session-start/session-shutdown hooks, cancellation and background startup: no new hooks, timers, polling, resident tasks or automatic retry loops.
- Add real coding-agent ModelRuntime/interactive-refresh regressions for both regions, including missing/obsolete/valid caches, delayed canceled results, offline operation and post-success request reuse.

## 0.2.1

- Discover models from the default CLI agent's server-provided `models` list instead of exposing the entire `/v3/config` model-definition registry. Match official CLI 2.161.0 ID/name/alias resolution, ordering, deduplication and custom/chat additions; keep regional and endpoint filters.
- Do not expand `modelTags` into an implicit allowlist. Keep legacy catalogs without `agents` compatible, but reject malformed/missing CLI selection when `agents` is present rather than widening to all definitions.
- Exclude explicitly tagged image/video generation models from the chat provider.
- Version projected cache entries so old unfiltered catalogs cannot reappear during startup or offline recovery. Account cache keys and credentials stay unchanged; the first upgrade needs an online catalog refresh.
- Keep model IDs dynamic: subsequent official list changes are picked up at startup or by the regional refresh command without updating the extension.
- Add offline regressions for CN-style mixed registries, agent selection, dynamic additions/removals, existing filters and cache migration.

## 0.2.0

- Add a second native Provider, `workbuddy-cn` (WorkBuddy AI CN), alongside the existing international `workbuddy` Provider.
- Keep separate regional profiles with their own fixed trusted HTTPS origins, account domains, and chat endpoints; reject cross-region credentials, domains, and endpoints.
- Isolate credentials and catalog caches by region and account. International credentials, caches, and model settings are not migrated or reused for CN; CN requires its own `/login` selection.
- Keep the international Provider ID, display name, command, cache keys, and default filtering unchanged, so existing international installs upgrade without re-login or data migration.
- Add `/workbuddy-cn [status|doctor|refresh]`; keep `/workbuddy [status|doctor|refresh]` for the international region. Models use the `workbuddy/` or `workbuddy-cn/` prefix respectively.
- Keep one shared pair of `session_start`/`session_shutdown` hooks for both regions; startup refreshes configured accounts in parallel and never contacts CN when no CN account is configured.
- Preserve the background interactive refresh, foreground headless refresh, and `PI_OFFLINE` cache-only contracts.
- Preserve existing international behavior and filtering defaults. The DeepSeek `-sg` exclusion stays an explicit international policy; CN does not inherit it. Eligible CN models and reasoning levels are projected from the catalog and capability supplements.
- Pin CN to the statically verified official WorkBuddy AI CN 5.8.3 profile: origin `https://www.workbuddy.cn`, chat `/v2/chat/completions`, catalog `/v3/config`, login platform `workbuddy`, and `User-Agent: WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` with `X-IDE-Version: 5.8.3`. International identity stays on 5.8.4.
- Use CN's selected account-scoped authentication flow: read `/v2/plugin/account` without a state query, retain the international `/v2/plugin/login/account?state=...` path, and propagate the server-issued account domain during login lookup.
- Keep cancellation for all regional refreshes until the complete batch settles, even if a disposed UI throws while reporting one region's failure.
- Scope CN to regular accounts on the official production SaaS origin: no cross-origin fallback, staging, self-hosted deployment, or wildcard SSO.
- Document the CN protocol provenance in [docs/cn-protocol.md](docs/cn-protocol.md); the CN path is statically verified but has not been validated against the real service.
- Keep unredacted upstream error bodies and the lightweight boundary: no proxy, CLI, resident task, or tools.
- Document that offline tests and static review do not prove real CN service availability or successful real-account CN login/inference.

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
