# WorkBuddy CN protocol baseline

Checked statically on 2026-10-27 against the official CN desktop artifact. This records protocol facts, not a successful real-account CN login, catalog request, or inference test. The extension remains unofficial and experimental.

## Official source and verification

- Update metadata: https://www.workbuddy.cn/v2/update?platform=workbuddy-darwin-arm64
- Reported product version: `5.8.3.41334564`.
- Official archive: https://download.codebuddy.cn/workbuddy/saas/darwin-arm64/WorkBuddy-darwin-arm64-5.8.3.41334564-db0e9b51.zip
- Metadata's published full-archive SHA-256: `5a88f67b0bfeb46d320be9d4e3c1f3b5f58ee8a24225a26f0d387c6f8c5f78d6`.

Only bounded HTTPS byte ranges for the central directory and relevant ZIP entries were downloaded. Extracted entries were checked against their ZIP CRC32 and uncompressed size. The full archive was **not** downloaded, so its published full-archive SHA-256 was **not independently verified**. No installer, desktop application, bundled CLI, or extracted JavaScript was executed. Custom scripts only parsed archive/ASAR metadata and read source text. No private account files or authenticated upstream/model requests were used for this protocol check.

Verified extracted-file SHA-256 values:

| Artifact path | SHA-256 |
| --- | --- |
| `Contents/Resources/app.asar` (96,506,567 bytes) | `a7eff702411704d140d7d8d706fe9e711d9b13e304928481c9eba0af9c06f731` |
| `app.asar.unpacked/cli/product.json` | `2ae6947b125a39bc6ea531a0e9fafe0e3e391019ae074654ae4d654ce8a08623` |
| `app.asar.unpacked/cli/package.json` | `4dc9e262a7c1e221e55a1bc5ab2d5ebe44fc8c4b37f51b07da62e3ce757ef0a5` |
| ASAR `main/dev-env-override.js` | `78f2cddd550d60eaecc146c4136e5a763296b5842b64fa59e32064fbcc56d720` |
| ASAR `main/server.js` | `913bc9ad1e301b6dedee2c7fbd3252025c66025cff6db44765760495255392c1` |
| ASAR `main/sidecar-manager.js` | `a51e1b7c2a59737101c7af5a2d015a8d28341ef1e5d637a2da4d5c2b6d7ba2f1` |

The proprietary artifacts and downloaded source are not distributed with this repository.

## Selected product and authentication flow

The official `cli/product.json` supplies:

| Field | CN value |
| --- | --- |
| `productName` / `applicationName` | `WorkBuddy` |
| `genieVersion` | `5.8.3` |
| `deploymentType` | `SaaS` |
| `endpoint` | `https://www.workbuddy.cn` |
| `authentication.type` | `account-scoped-external-link` |
| `authentication.attributes.prefixPath` | `/plugin` |
| `authentication.attributes.platform` | `workbuddy` |

The top-level `platform: CLI` is **not** the browser-login platform parameter. Authentication uses the nested value `workbuddy`, not the international extension's `workbuddy-ai`.

`main/dev-env-override.js` contains both the legacy external-link implementation and the selected `AccountScopedExternalLinkAuthenticationProvider`. The latter's `createSession()` polls the token and then calls `loopGetCurrentAccount()` / `fetchCurrentAccount()`. In particular, **CN looks up the account at `/v2/plugin/account` without a state query**, not the legacy `/v2/plugin/login/account?state=...` route retained by the international provider.

| Operation | CN request |
| --- | --- |
| Request browser login state | `POST /v2/plugin/auth/state?platform=workbuddy` |
| Poll token | `GET /v2/plugin/auth/token?state=...` |
| Read current account | `GET /v2/plugin/account` |
| Refresh token | `POST /v2/plugin/auth/token/refresh` |
| Model catalog | `GET /v3/config` |
| Chat | `POST /v2/chat/completions` |

The same module uses pending business codes `11217` for token polling and `12151` for account polling, an envelope containing `data`, and `accessToken` / `refreshToken` / `expiresAt` or `expiresIn` fields. Refresh sets `X-Refresh-Token` and `X-Auth-Refresh-Source: plugin`. `calculateExpiresAt()` derives milliseconds from `expiresIn` seconds when an absolute expiry is absent.

The catalog path comes from `DEFAULT_CONFIG_PATH` in `CloudProductProvider`. `main/server.js` defines the chat path and gateway-header construction. These are static observations; availability, account permissions, model support, and private API stability are not guaranteed.

## Account domain and fixed trust boundary

Official production entries in `authentication.attributes.internalDomain` are:

- `www.workbuddy.cn`
- `www.codebuddy.cn`
- `copilot.tencent.com`

The official list also contains staging hosts and separate external/SSO domain lists. This integration deliberately does **not** adopt all of those lists: `src/regions.js` accepts only the three exact production account domains above and their HTTPS browser-login origins. It excludes staging, international, wildcard SSO and self-hosted deployments.

`X-Domain` is account metadata, not a request destination. The official account-scoped provider's `enterpriseHeaders()` prefers the token's `domain`, falling back to the configured endpoint authority. The extension follows that ordering for account lookup and stored credentials: a server-issued supported `token.domain` wins; `www.workbuddy.cn` is the fallback when it is missing. A CN credential may therefore have `domain: copilot.tencent.com` while requests still go only to `https://www.workbuddy.cn`.

The official desktop also describes alternate/back-up origins, including `copilot.tencent.com` and `wb.tencentbuddy.com`. The extension intentionally does **not** implement cross-origin failover or derive an endpoint from `X-Domain`. Login, refresh, catalog and chat remain pinned to the CN primary origin. Redirects and foreign chat endpoints are rejected. International tokens and account domains cannot be used by the CN provider, or vice versa.

Scope is the official production SaaS flow for ordinary accounts. Desktop account-switching, account-list management, private deployments and wildcard enterprise SSO are not implemented. The international provider keeps its existing identifier, profile and v1 cache identity; CN uses its own `workbuddy-cn` credential/model-store entry and account-scoped cache key.

## Client identity

`main/server.js`, `buildVlmGatewayHeaders()`, constructs two product/platform WorkBuddy UA tokens and an optional CLI token. `main/sidecar-manager.js` supplies the WorkBuddy desktop client information. The official `cli/package.json` declares the published CLI version as `publishConfig.customPackage.version = 2.161.0`; its development `version: 0.0.0` is not the wire CLI version.

| Header | CN wire baseline |
| --- | --- |
| `User-Agent` | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` |
| `X-IDE-Type` | `WorkBuddy` |
| `X-IDE-Name` | `WorkBuddy` |
| `X-IDE-Version` | `5.8.3` |

These values are pinned separately from the international 5.8.4 baseline and the extension's local version. Each region uses its own immutable client-header profile for login, account lookup, refresh, catalog, authentication and scoped chat transport.

This is not a packet capture or a complete desktop-client emulation. Other official paths may add headers, trace/device fields or account behavior. The extension does not collect hardware identifiers, send telemetry, change Pi prompts/tools, claim eligibility for rewards, or bypass account, geographic, credit or rate limits.

## Model and test policy

The international integration's DeepSeek `-sg` exclusion is retained only for that region. It is an integration policy, not a requirement inferred from the CN protocol. CN projects eligible models selected by the default CLI agent in its own account catalog without that exclusion, not the full model-definition registry. Vendor capability supplements remain optimistic metadata, not live verification of the CN gateway.

### Agent model selection (0.2.1)

Read-only inspection of the official npm artifact `@tencent-ai/codebuddy-code@2.161.0`, `package/dist/codebuddy.js`, located `AgentManager.computeModelsFromRaw()` / `computeModels()`. These resolve the current agent's `models` entries by ID, then name, then alias, preserve order and deduplicate, then append models tagged `custom` / `chat` or prefixed `custom:`. The default CLI base agent is selected by `cli` / `default` tags, with a legacy `name: cli` fallback. The verified code does not expand `modelTags: ["craft"]` into all matching definitions. The extension follows that list-selection behavior, then applies its own regional, endpoint and chat-compatibility filters. It does not emulate every official product transformation (for example feature-gated Auto tier replacement), local custom-model configuration, or entitlement logic.

A read-only CN catalog check on 2026-10-28 found 61 definitions, a 19-ID `cli.models` list, and no top-level `availableModels`. The old projection accepted 60 definitions after excluding `wb-lite`; it ignored the agent list and admitted completion and media models. This is a catalog observation, not an inference test or a guarantee that all 19 candidates are usable. No raw account catalog, credentials or proprietary bundle is included in the repository. The regression tests use synthetic catalogs.

Offline tests cover independent login credentials and refresh locks, both account-lookup routes, token-domain propagation, isolated model stores, cross-region rejection, scoped dispatch, cancellation and shared lifecycle hooks. Real-service text/tool/image compatibility and long-term token refresh still require an explicitly authorized user test. Static source inspection and mocked success responses do not establish that every CN account can use this integration.
