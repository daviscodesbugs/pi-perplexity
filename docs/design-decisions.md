# Design Decisions

## AUTH errors do not auto-clear the cached token

When Perplexity returns 401/403 and `SearchError("AUTH")` is thrown, `src/index.ts` returns an error message directing the user to run `/perplexity-login --force`. It does **not** call `clearToken()` automatically.

**Rationale:** A 401 can be transient — network blip, Cloudflare hiccup, clock skew. Auto-clearing on every 4xx would silently discard a still-valid token and force unnecessary re-authentication. The user decides when to re-login. `/perplexity-login --force` clears and re-authenticates in one explicit step.

The token is only cleared when the user explicitly requests it (`--force`) or calls `clearToken()` directly (e.g. in tests or future tooling).

## Why `node-tls-client` instead of Bun subprocess, pure-Node TLS forging, or `curl-impersonate`

Cloudflare TLS-fingerprints the SSE endpoint. The transport must mimic a real browser's ClientHello (cipher order, extensions, GREASE, ALPN).

Considered:

1. **Pure-Node TLS forging** (custom undici dispatcher, manual TLS shaping). Node's `tls` module doesn't let JS reshape the handshake; it's whatever OpenSSL/BoringSSL was compiled with. Rejected as fragile and high-maintenance.
2. **`curl-impersonate` system binary subprocess.** Same UX problem as Bun: requires a separate install, painful on Windows.
3. **Bun subprocess (status quo).** Works, but makes Bun a hard end-user prerequisite for what is fundamentally one HTTP call.
4. **`node-tls-client`** (chosen). Wraps `bogdanfinn/tls-client` (Go), ships prebuilds for Win/macOS/Linux × x64/arm64 via npm. Named profiles (`chrome_131`) make version bumps cheap when Cloudflare updates detection.

Trade-offs accepted: ~10–15MB native binary inside `node_modules`, periodic profile bumps when Cloudflare updates, no support for niche platforms without prebuilds (musl/alpine, FreeBSD).

See [`specs/2026-05-15-remove-bun-dependency-design.md`](specs/2026-05-15-remove-bun-dependency-design.md) for the full design.
