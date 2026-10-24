# Third-party source attribution

This project is a derivative of **lutfi238/pi-workbuddy**, licensed under MIT.

- Upstream: https://github.com/lutfi238/pi-workbuddy
- Reviewed version: npm `pi-workbuddy@0.2.4`
- Git commit: `55b3baafce9099aed3aa98d1a1714c467e741b60`
- npm archive: https://registry.npmjs.org/pi-workbuddy/-/pi-workbuddy-0.2.4.tgz
- Verified archive SHA-512 (base64):
  `uEf7m7AskqMvT9DYAeC1mXN4hr6vqIiSOFcxiLRsB8GhLMADi7qPVWDoFaKSAdZZR+W4SJEMPCtoJ/zmWCVfXg==`
- Copyright: (c) 2026 pi-workbuddy contributors
- Original permission and warranty text is retained in LICENSE.

## Retained / adapted runtime files

The following files retain or adapt upstream source:

- `src/client-identity.js`: retains the inspected WorkBuddy protocol baseline; changes this derivative's extension version.
- `src/native-client.js`: retains browser login, polling, token refresh, account-header validation and authenticated catalog access; removes credit-reader imports and methods.
- `src/native-errors.js`: retains allowlisted sanitized diagnostics; removes unused credit-reader categories.
- `src/native-transport.js`: retains provider-scoped identity headers, gzip and SSE adaptation.
- `src/native-models.js`, `src/native-capabilities.js`, `src/native-limits.js`: retain upstream metadata projection, capability references and output-budget protections. References are upstream's optimistic metadata policy, not newly performed live service verification.
- `src/native-catalog-cache.js`: retains account-scoped public metadata caching.
- `src/native-provider.js`: adapts the complete Pi Provider and command registration; ordinary unforced refreshes stay cache-only.
- `src/native-lifecycle.js`: adapts startup refresh and guarded selected-model recovery. No per-turn/UI hooks remain.

The original bridge mode, credit/package readers, Pendant UI/host patches and tooltip lifecycle are intentionally omitted. No vendor bundles, application snapshots or extracted account data are included.

## Retained / adapted tests

The following synthetic tests were copied from the same upstream Git commit:

- `test/client-identity.test.js`
- `test/native-capabilities.test.js`
- `test/native-catalog-cache.test.js`
- `test/native-limits.test.js`
- `test/native-pi.test.js`
- `test/native.test.js`

The catalog-refresh fixtures were adapted to request `force: true` under this derivative's explicit-refresh policy. New idle/lifecycle and actual Pi-loader tests, the test-only network firewall, package assembly, documentation and static checks were added for this repository.

MIT permits modification and redistribution provided the original copyright and permission notice remain. This attribution does not imply endorsement by upstream or WorkBuddy.
