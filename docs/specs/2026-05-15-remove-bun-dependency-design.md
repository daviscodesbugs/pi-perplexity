# Remove Bun runtime dependency

**Status:** Proposed
**Date:** 2026-05-15
**Author:** brainstormed via pi coding agent

## Goal

Eliminate Bun as a user-facing prerequisite. After this change, end users install `pi-perplexity` and it works on plain Node.js (≥20) on Windows, macOS, and Linux — no `bun` on PATH, no subprocess spawn, no PATH lookup.

## Motivation

Today the search client shells out to `bun -e "<inline script>"` so that Bun's TLS stack (different ClientHello fingerprint than Node's undici) can clear Cloudflare's bot protection on `www.perplexity.ai/rest/sse/perplexity_ask`. This makes Bun a hard prerequisite for every user, even though only one HTTP call in the codebase actually needs the fingerprint bypass.

Bun-on-PATH is a meaningful friction point: it adds a runtime install step, complicates Windows usage, and couples the project's reliability to a fast-moving runtime for what is fundamentally one fetch call.

## Non-goals

- **Streaming SSE output.** The current Bun path buffers the full response before emitting, then synthesizes a `ReadableStream` from the buffered text (`streamFromText`). This design preserves that behavior exactly. True incremental SSE rendering is a worthwhile follow-up but is out of scope here.
- **Auth flow changes.** Auth endpoints are not Cloudflare-challenged in the current code path and use Node's plain `fetch` already. They are untouched.
- **Test runner migration.** Tests continue to run under `bun test`. Contributors still need Bun for development; this change is scoped to *end-user* prerequisites. A follow-up can migrate tests to `node --test` or vitest.
- **Pure-JS TLS fingerprint forging.** Considered and rejected — too fragile, requires ongoing maintenance to chase Cloudflare updates.

## Approach

Replace `fetchViaBunRuntime` in `src/search/client.ts` with a call into [`node-tls-client`](https://www.npmjs.com/package/node-tls-client), an npm package wrapping `bogdanfinn/tls-client` (Go). It ships prebuilt native binaries for Windows / macOS / Linux on x64 + arm64 and exposes a `fetch`-like API with named browser-impersonation profiles (e.g. `chrome_131`).

From the user's perspective: `npm install` (or `pi install`) pulls down the appropriate prebuilt binary into `node_modules` and the extension just works. No PATH, no extra install step, no subprocess.

## Code changes

### `src/search/client.ts`

- **Remove** `fetchViaBunRuntime` (≈75 lines including the inline Bun script, `spawn` plumbing, stdout buffering, and JSON parsing).
- **Remove** the runtime branch `const useBunSubprocess = typeof Bun === "undefined";` and the dual code path in `searchPerplexity`. There is now a single path that always uses `node-tls-client`.
- **Add** a small helper `fetchViaTlsClient(url, headers, body, signal)`:
  - Lazily constructs a module-level `Session` from `node-tls-client` with `clientIdentifier: "chrome_131"` (or whichever recent profile is current at implementation time — see Decision B).
  - Issues a `POST` with the given headers and body.
  - Awaits `.text()` for the full SSE response body.
  - Returns `{ status, bodyText }` — the same shape as the function it replaces, so call sites downstream are unchanged.
  - Wires `AbortSignal` into the session's request abort mechanism.
- **Keep** `streamFromText` and the rest of `searchPerplexity` unchanged. The merge loop continues to read SSE events from the buffered text.
- **Add** one new error-mapping case: if `status === 403` and the body contains a Cloudflare challenge marker (e.g. `cf-mitigated`, `"Just a moment..."`, `Attention Required`), throw `SearchError("NETWORK", "Cloudflare blocked this request. Update pi-perplexity or open an issue.")`. This gives users a clear actionable signal when the impersonation profile needs bumping.

Net diff in `client.ts`: approximately **−90 / +25 lines**.

### Everything else in `src/`

- `src/auth/*` — untouched. Auth already uses Node's plain `fetch` successfully.
- `src/commands/*`, `src/render/*`, `src/index.ts`, `src/config.ts`, `src/constants.ts` — untouched.
- `src/search/stream.ts`, `format.ts`, `models.ts`, `types.ts` — untouched.

## Dependency & packaging changes

### `package.json`

- `dependencies`:
  - Remove `bun: "^1.3.9"`.
  - Add `node-tls-client: "<latest>"` (pinned to a specific version at implementation time).
- `engines`:
  - Remove `bun`.
  - Add `node: ">=20"` (Node 20+ has native `fetch`, `ReadableStream`, `crypto.randomUUID`, `AbortSignal`).
- `peerDependencies`, `optionalDependencies`: no changes.
- `scripts`: `test` continues to use `bun test` per Decision A.

### Files

- Delete `bun.lock`.
- Generate `package-lock.json` on next install. (`pi install` handles whichever lockfile is present.)

### Postinstall

None required. `node-tls-client` resolves the correct prebuilt binary during normal `npm install` via its own install hook.

## Tests

### What changes

- Delete any test specifically targeting `fetchViaBunRuntime` or the `spawn("bun", …)` path. (Confirm by grep at implementation time — likely zero or one test.)
- Add one new unit test: assert that `fetchViaTlsClient` is invoked with the configured Chrome profile and that request headers + body are forwarded intact. Mock `node-tls-client`'s `Session.post`.

### What stays the same

- All tests that mock at the SSE event layer (the majority) continue to work without modification.
- The opt-in live E2E test `PI_PERPLEXITY_E2E=1 bun test test/e2e-models.test.ts` continues to work — it hits real Perplexity and just exercises the new code path.

### Verification gates (must pass before merge)

1. `bunx tsc --noEmit` — clean.
2. `bun test` — all green.
3. Manual smoke: run `/perplexity-login` then a real search query on each of macOS arm64 and Linux x64 at minimum. Windows verification is nice-to-have given lack of CI.

## Docs

- **`README.md`**:
  - Remove `Bun (available on PATH)` from Requirements.
  - Rewrite the "How It Works" paragraph: explain that Cloudflare TLS-fingerprints the endpoint, so the client uses `node-tls-client` with a Chrome impersonation profile. One short paragraph.
  - Update the Development section to reflect that contributors still need Bun for `bun test` (Decision A).
- **`CHANGELOG.md`**: add an entry under a new minor version. Headline: "Bun is no longer required for end users." Mention the new `node-tls-client` dependency and the supported-platform matrix.
- **`plan.md`**: this is historical implementation notes. Add a brief note at the top that the Bun runtime requirement was removed in vX.Y.Z, but leave the original content for context.
- **`docs/design-decisions.md`**: add an entry summarizing the choice of `node-tls-client` over alternatives (pure-Node TLS forging, `curl-impersonate` subprocess, `cycletls`, etc.) and pointing at this spec.
- **`AGENTS.md`**: review for any Bun-on-PATH mentions and update.

## Decisions locked in

### A. Test runner: stay on Bun (for now)

Tests continue to run under `bun test`; `bun` stays in devDependencies. End users don't need it; contributors do. A future change can migrate to Node-native testing.

**Trade-off accepted:** Contributors still install Bun. This is a smaller, more tolerant audience than end users.

### B. Pin to a specific Chrome profile

The implementation pins to one specific `node-tls-client` Chrome profile (e.g. `chrome_131`) rather than tracking a "latest" alias. When Cloudflare updates its detection, bump the profile and the package version, document in CHANGELOG.

**Trade-off accepted:** Periodic maintenance bumps. Worth it for predictable, debuggable behavior.

### C. Unsupported platforms: hard error

If `node-tls-client` doesn't have a prebuild for the user's platform (e.g. musl/alpine, FreeBSD, some niche ARM variants), `require()` fails at import time and the extension surfaces a clear error: "pi-perplexity is supported on Windows / macOS / Linux × x64 / arm64. For other platforms, please open an issue." Document in README.

**Trade-off accepted:** Some users on unusual platforms lose access. They were also relying on Bun's prebuild matrix, which is comparable in coverage; the actual delta is small.

## Risks

1. **Cloudflare updates its detection and the pinned Chrome profile starts failing.** Mitigated by the explicit error message users will see (Decision B's CF-challenge detector) and the fact that updating is a one-line version bump on `node-tls-client`. Add a CHANGELOG note for users who hit this.
2. **`node-tls-client` becomes unmaintained.** Real but slow-moving risk; Go-based TLS-impersonation libraries are a small but established niche. If it dies, the fallback is `cycletls` or `curl-impersonate-node` (same problem shape, different binding). Migration would touch only `fetchViaTlsClient`.
3. **Streaming regression discovered later.** Buffered behavior is preserved exactly, so users see no change from today. A real streaming follow-up is purely additive.
4. **Native module install issues on locked-down environments** (no network during `npm install`, corporate proxies, etc.). Same class of risk as installing Bun was. Net-neutral.

## Rollback

If this change ships and breaks for many users:

1. Revert the `client.ts` and `package.json` commits.
2. Re-add `bun.lock`.
3. Republish previous version with a patch bump.

Because all changes are confined to `src/search/client.ts` and `package.json`, rollback is mechanical.

## Open questions for implementation phase (not blocking spec approval)

- Exact `node-tls-client` API surface — `Session.post` vs `session.fetch()`, exact abort wiring. Confirm during implementation.
- Exact CF-challenge detection heuristic (which header / body marker is most reliable).
- Whether `chrome_131` or a different specific profile is the right initial pin — pick the most recent stable one available in the library at implementation time.
