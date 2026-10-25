# WorkBuddy AI client identity baseline

Version 0.1.1 removes the upstream plugin's self-identifying Pi HTTP fields. Local package identity and network client identity are separate:

| Field | Wire value |
| --- | --- |
| User-Agent | `WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0` |
| X-IDE-Type | `WorkBuddy` |
| X-IDE-Name | `WorkBuddy` |
| X-IDE-Version | `5.8.4` |

`EXTENSION_VERSION` remains local metadata for package/status output. It is not used as `X-IDE-Version` or appended to the UA. The same immutable profile is used by login, account lookup, token refresh, catalog requests, request authentication, and the final provider-scoped chat fetch. Final chat headers replace SDK-supplied identity fields case-insensitively.

## Primary source, inspected statically

- Official download metadata:
  https://www.workbuddy.ai/v2/update?platform=workbuddy-darwin-arm64
- Metadata version: `5.8.4.41366630`.
- Official archive:
  https://download.codebuddy.ai/workbuddy/saas/darwin-arm64/WorkBuddy-darwin-arm64-5.8.4.41366630-73952edb.zip
- ASAR package identity: `@genie/workbuddy-desktop@5.8.4`.
- Extracted ASAR SHA-256:
  `3f77e5cb036d0066fa6afa67bc9498d7fddd432eed927d4b576bfe91ddb23a49`.
- Bundled CLI source SHA-256:
  `de2d4697eda6f89309b2a24bd7f8c34b00d3f8bb41e9e708b49a4c8fe3d8954b`.
- Bundled CLI package metadata SHA-256:
  `4dc9e262a7c1e221e55a1bc5ab2d5ebe44fc8c4b37f51b07da62e3ce757ef0a5`.

Only bounded ZIP ranges for relevant source/metadata were downloaded. Individual ZIP entries were checked against their CRC32 and size. The full archive was not downloaded, so its published full-archive SHA-256 was not independently checked. No installer, desktop app, bundled CLI, or extracted application code was executed. No private account data was read, and no authenticated upstream/model requests were sent.

Static observations in that artifact:

- `main/sidecar-manager.js`, `getCachedBaseEnv()`: desktop client platform and IDE type use `WorkBuddy`, product/platform versions use the desktop version, and the bundled CLI adds its own version token.
- `main/server.js`, the default `ConfigService` IDE info: both IDE name and IDE type are `WorkBuddy`.
- `main/server.js`, `buildVlmGatewayHeaders()`: explicitly constructs the two WorkBuddy UA tokens plus optional CLI token and the same IDE name/type/version fields above.
- `main/dev-env-override.js`, `UserAgentHttpInterceptor`: constructs a version-aware product/platform UA.
- `cli/package.json`: the development version is `0.0.0`; the declared published CLI version is `publishConfig.customPackage.version = 2.161.0`.

These are a pinned official desktop gateway-header baseline, not a packet capture or proof that every official request path uses byte-identical headers. Different app versions, paths, settings and environments can add or override fields. The official source contains other headers and tracing/device metadata; this fix does not invent or collect hardware identifiers, add telemetry, or alter the Pi system prompt.

## Scope and limitations

This change only adjusts client-identification headers. Account tokens, origin restrictions, usage/credit policy, prompt/tool content, correlation IDs, gzip and SSE handling remain unchanged. It adds no global hooks, timers, background work or runtime dependencies.

Historical usage rows already stored by the service are not rewritten. New usage attribution is decided by the service; an offline header assertion cannot verify the production UI. No claim is made that Pi becomes indistinguishable from the official app, eligible for client-specific rewards, or exempt from service terms, permissions, rate limits or quotas.

The extracted proprietary application files are not distributed with this repository; this document records protocol facts and provenance only.
