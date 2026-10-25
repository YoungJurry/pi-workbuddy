# Changelog

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
