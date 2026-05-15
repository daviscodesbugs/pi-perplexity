# Remove Bun Runtime Dependency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop Bun as an end-user prerequisite. Replace the Bun-subprocess Cloudflare bypass in `src/search/client.ts` with `node-tls-client`, an npm package that ships prebuilt Go-based TLS-impersonation binaries.

**Architecture:** Extract the single HTTP call into a small module `src/search/http.ts` that wraps `node-tls-client.Session` (Chrome profile). `searchPerplexity` calls into this seam via an injectable parameter so tests can substitute a mock without touching `globalThis.fetch`. Buffered SSE behavior is preserved exactly — only the transport changes.

**Tech Stack:** TypeScript, Node ≥20, `node-tls-client`, `bun test` (devDep only, kept for now), `@sinclair/typebox`, pi-tui/pi-ai.

**Spec:** [`docs/specs/2026-05-15-remove-bun-dependency-design.md`](../specs/2026-05-15-remove-bun-dependency-design.md)

**Branch:** `remove-bun-dep` (already created and design spec committed).

---

## File Map

**Create:**
- `src/search/http.ts` — wraps `node-tls-client.Session` in one function `postWithFingerprint(url, headers, body, signal) → {status, bodyText}`.
- `test/search/http.test.ts` — unit tests for the new module.

**Modify:**
- `src/search/client.ts` — remove `fetchViaBunRuntime`, remove `useBunSubprocess` branch, accept an optional HTTP fetcher param for DI, add Cloudflare-challenge detection.
- `test/search/client.test.ts` — replace `globalThis.fetch` mocks with DI of a mock fetcher.
- `package.json` — drop `bun` runtime dep, drop `engines.bun`, add `node-tls-client`, add `engines.node: ">=20"`.
- `README.md` — drop Bun from Requirements, rewrite "How It Works" paragraph, note Development still uses Bun.
- `CHANGELOG.md` — entry for the dep change.
- `docs/design-decisions.md` — append a decision entry pointing at the spec.
- `plan.md`, `AGENTS.md` — sweep for stale Bun references and update.

**Delete:**
- `bun.lock` — no longer the lockfile of record; `npm install` (or whatever `pi install` uses) regenerates.

---

## Task 1: Add `node-tls-client`, drop `bun` from runtime deps

**Files:**
- Modify: `package.json`
- Delete: `bun.lock`

- [ ] **Step 1: Update `package.json`**

Replace the current `dependencies`, `engines`, and (only the keyspace-affecting part of) the file. Final state of these blocks:

```json
"dependencies": {
  "node-tls-client": "^1.8.0"
},
"engines": {
  "node": ">=20"
}
```

Leave `devDependencies`, `peerDependencies`, `scripts`, `files`, and the `pi` block untouched. `bun-types` stays in `devDependencies` because tests still use `bun:test` (Decision A from the spec).

If `^1.8.0` is not the current latest `node-tls-client` major, use the actual latest stable version at implementation time. Confirm by running `npm view node-tls-client version` before committing.

- [ ] **Step 2: Delete `bun.lock`**

```bash
git rm bun.lock
```

- [ ] **Step 3: Install and regenerate lockfile**

```bash
bun install
```

This regenerates `bun.lock` (still used locally by contributors) with the new dependency set. Yes, we just deleted it and now we're regenerating it — the point of the delete was to drop the *old* committed lockfile so the new dep tree is canonical. The regenerated `bun.lock` will be committed.

Expected: install completes, `node-tls-client` appears in `node_modules/`, `bun` no longer appears as a top-level runtime dep.

- [ ] **Step 4: Sanity-check the install**

```bash
ls node_modules/node-tls-client/
node -e "const m = require('node-tls-client'); console.log(Object.keys(m));"
```

Expected: directory exists; second command prints exported symbols including `Session` (or whatever the current export name is — confirm now so later tasks use the right name).

- [ ] **Step 5: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: clean. No code has changed yet, so this is a smoke check that the dep swap didn't break type resolution.

- [ ] **Step 6: Run existing tests**

```bash
bun test
```

Expected: all green. No code touched yet, so this is purely a regression-confidence check that removing `bun` from `dependencies` (where it should never have been needed at *runtime* anyway since pi loads under Node) didn't break anything.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: replace bun runtime dep with node-tls-client

End users no longer need bun on PATH. Bun stays in devDependencies
for the test suite (bun:test). Lockfile regenerated."
```

---

## Task 2: Stub `src/search/http.ts` and its test (failing)

**Files:**
- Create: `src/search/http.ts`
- Create: `test/search/http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/search/http.test.ts` with the following content:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

describe("postWithFingerprint", () => {
  let postWithFingerprint: typeof import("../../src/search/http.js").postWithFingerprint;
  let sessionPostCalls: Array<{ url: string; init: Record<string, unknown> }>;
  let sessionConstructorCalls: Array<Record<string, unknown>>;

  beforeEach(async () => {
    sessionPostCalls = [];
    sessionConstructorCalls = [];

    class FakeSession {
      constructor(opts: Record<string, unknown>) {
        sessionConstructorCalls.push(opts);
      }
      async post(url: string, init: Record<string, unknown>) {
        sessionPostCalls.push({ url, init });
        return {
          status: 200,
          text: async () => "data: {\"final\":true}\n\ndata: [DONE]\n\n",
        };
      }
      async close() {}
    }

    mock.module("node-tls-client", () => ({ Session: FakeSession }));

    const mod = await import(`../../src/search/http.ts?t=${Date.now()}`);
    postWithFingerprint = mod.postWithFingerprint;
  });

  afterEach(() => {
    mock.restore();
  });

  test("constructs a Session with the pinned Chrome profile", async () => {
    await postWithFingerprint("https://example.com", { "X-A": "1" }, "body", undefined);

    expect(sessionConstructorCalls).toHaveLength(1);
    expect(sessionConstructorCalls[0]).toMatchObject({ clientIdentifier: "chrome_131" });
  });

  test("forwards method, headers, and body to Session.post", async () => {
    await postWithFingerprint(
      "https://example.com/x",
      { "Content-Type": "application/json", Authorization: "Bearer t" },
      '{"q":"hi"}',
      undefined,
    );

    expect(sessionPostCalls).toHaveLength(1);
    expect(sessionPostCalls[0].url).toBe("https://example.com/x");
    expect(sessionPostCalls[0].init).toMatchObject({
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: '{"q":"hi"}',
    });
  });

  test("returns {status, bodyText} shaped result", async () => {
    const result = await postWithFingerprint("https://example.com", {}, "", undefined);
    expect(result).toEqual({
      status: 200,
      bodyText: "data: {\"final\":true}\n\ndata: [DONE]\n\n",
    });
  });

  test("propagates abort signal to Session.post", async () => {
    const controller = new AbortController();
    await postWithFingerprint("https://example.com", {}, "body", controller.signal);
    expect(sessionPostCalls[0].init.signal).toBe(controller.signal);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/search/http.test.ts
```

Expected: FAIL — module `src/search/http.ts` not found (file doesn't exist yet).

- [ ] **Step 3: Create the module stub**

Create `src/search/http.ts`:

```ts
import { Session } from "node-tls-client";

export interface HttpResponse {
	status: number;
	bodyText: string;
}

let sessionPromise: Promise<InstanceType<typeof Session>> | null = null;

function getSession(): Promise<InstanceType<typeof Session>> {
	if (!sessionPromise) {
		sessionPromise = Promise.resolve(new Session({ clientIdentifier: "chrome_131" }));
	}
	return sessionPromise;
}

/**
 * POST `body` to `url` with the configured TLS fingerprint (Chrome).
 * Returns the buffered response (status + full body text).
 * Wraps `node-tls-client` so the rest of the codebase has no direct dependency on its API.
 */
export async function postWithFingerprint(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal | undefined,
): Promise<HttpResponse> {
	const session = await getSession();
	const response = await session.post(url, { headers, body, signal });
	const bodyText = await response.text();
	return { status: response.status, bodyText };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test test/search/http.test.ts
```

Expected: PASS — all 4 tests green.

If `node-tls-client`'s actual API differs (e.g. the option key is `clientIdentifier` vs `client_identifier`, or `post` takes a different shape, or the constructor is async-only via a factory), fix `http.ts` to match the real library and re-run. The test's expectations on the fake Session define the contract `http.ts` adheres to; update both the test and the impl in lockstep if reality differs from the assumed API.

- [ ] **Step 5: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/search/http.ts test/search/http.test.ts
git commit -m "feat(search): add http.ts wrapper around node-tls-client

Single-purpose module: POST with Chrome TLS fingerprint, return
{status, bodyText}. Wraps node-tls-client so the rest of the codebase
stays oblivious to its API surface. Pinned to chrome_131 profile per
spec Decision B."
```

---

## Task 3: Make `searchPerplexity` accept an injected HTTP fetcher (failing test first)

**Files:**
- Modify: `src/search/client.ts`
- Modify: `test/search/client.test.ts`

This task adds a DI seam to `searchPerplexity` so tests don't need `globalThis.fetch` monkey-patching. The seam is an optional 4th parameter typed as `typeof postWithFingerprint`, defaulting to the real function. Production callers (`src/index.ts`) need no changes.

- [ ] **Step 1: Add the failing test for DI**

Append the following test to `test/search/client.test.ts` (inside the `describe("searchPerplexity", ...)` block):

```ts
test("uses the injected http fetcher instead of node-tls-client when provided", async () => {
	const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
	const fakeHttp = async (url: string, headers: Record<string, string>, body: string) => {
		calls.push({ url, headers, body });
		return {
			status: 200,
			bodyText:
				'data: {"status":"COMPLETED","final":true,"blocks":[' +
				'{"intended_usage":"markdown_block","markdown_block":{"answer":"hi"}}' +
				']}\n\n' +
				'data: [DONE]\n\n',
		};
	};

	const result = await searchPerplexity(
		{ query: "q", model: "pplx_pro_upgraded", incognito: true },
		"jwt",
		undefined,
		fakeHttp,
	);

	expect(calls).toHaveLength(1);
	expect(calls[0].url).toBe("https://www.perplexity.ai/rest/sse/perplexity_ask");
	expect(calls[0].headers["Authorization"]).toBe("Bearer jwt");
	expect(result.answer).toBe("hi");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/search/client.test.ts
```

Expected: FAIL — `searchPerplexity` currently takes 3 args and ignores any 4th. The test's `fakeHttp` is never called, so `calls.length` is 0 (or the test errors because real `fetch` to Perplexity is attempted and times out, or because `Bun` is defined and the existing `else` branch fires).

- [ ] **Step 3: Refactor `searchPerplexity` to accept the injected fetcher**

In `src/search/client.ts`:

1. At the top of the file, add:

```ts
import { postWithFingerprint, type HttpResponse } from "./http.js";

export type HttpFetcher = (
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal | undefined,
) => Promise<HttpResponse>;
```

2. Change the `searchPerplexity` signature from:

```ts
export async function searchPerplexity(
	params: SearchParams,
	jwt: string,
	signal?: AbortSignal,
): Promise<SearchResult> {
```

to:

```ts
export async function searchPerplexity(
	params: SearchParams,
	jwt: string,
	signal?: AbortSignal,
	httpFetcher: HttpFetcher = postWithFingerprint,
): Promise<SearchResult> {
```

3. Inside the function body, **leave the existing dual-path logic intact for now** (we remove it in Task 4). The new `httpFetcher` param is unused this task. The point of this task is the seam itself.

Wait — that won't make the test pass. The test asserts `fakeHttp` is called, but if we don't wire it in, it won't be. So we *also* need to insert a single line at the top of `searchPerplexity` that, when `httpFetcher` is non-default, uses it.

Replace the dual-path block:

```ts
const useBunSubprocess = typeof Bun === "undefined";

if (useBunSubprocess) {
	let bunResult: { status: number; bodyText: string };
	// ...
	eventStream = streamFromText(bunResult.bodyText);
} else {
	let response: Response;
	// ...
	eventStream = response.body;
}
```

with:

```ts
let httpResult: HttpResponse;
try {
	httpResult = await httpFetcher(
		PERPLEXITY_ENDPOINT,
		requestHeaders,
		JSON.stringify(requestBody),
		signal,
	);
} catch (error) {
	if (signal?.aborted) {
		throw new SearchError("NETWORK", "Perplexity request was cancelled.");
	}
	throw new SearchError(
		"NETWORK",
		`Could not connect to Perplexity. ${errorMessage(error)}`,
	);
}

if (httpResult.status !== 200) {
	throw mapHttpError(httpResult.status);
}
if (!httpResult.bodyText) {
	throw new SearchError("STREAM", "Perplexity returned an empty response.");
}

eventStream = streamFromText(httpResult.bodyText);
```

Also delete the now-unused `fetchViaBunRuntime` function (≈75 lines, starts at the comment `* Execute a Perplexity request via a Bun subprocess.` and ends with its closing brace) and the `MAX_BUN_STDOUT` constant.

`streamFromText` stays — it's still used to wrap the buffered body for the SSE reader.

- [ ] **Step 4: Run the new test to verify it passes**

```bash
bun test test/search/client.test.ts -t "uses the injected http fetcher"
```

Expected: PASS.

- [ ] **Step 5: Run the full client test file to see what now breaks**

```bash
bun test test/search/client.test.ts
```

Expected: the new test PASSES; the *old* tests that mock `globalThis.fetch` now FAIL because `searchPerplexity` no longer calls `fetch` directly — it calls `postWithFingerprint`, which is unmocked and tries to hit real Perplexity (and either errors out on network or times out).

Do NOT fix those failures here — that's Task 4's job. Just confirm the breakage shape matches expectations.

- [ ] **Step 6: Commit**

```bash
git add src/search/client.ts test/search/client.test.ts
git commit -m "refactor(search): inject HTTP fetcher into searchPerplexity

Replace the dual fetch/spawn(bun) path with a single call site that
accepts an optional fetcher (defaults to postWithFingerprint from
http.ts). Drops fetchViaBunRuntime and MAX_BUN_STDOUT. Existing
fetch-mocking tests break in this commit and are migrated in the
next one — they're left failing intentionally to keep the diff
focused."
```

---

## Task 4: Migrate existing client tests from `globalThis.fetch` to DI mocks

**Files:**
- Modify: `test/search/client.test.ts`

The existing tests mock `globalThis.fetch` and assert against `RequestInit`. After Task 3 they no longer drive `searchPerplexity`'s code path. Migrate each one to inject a fake `HttpFetcher` and assert against the captured `{url, headers, body}`.

- [ ] **Step 1: Delete the obsolete fetch-mock setup**

In `test/search/client.test.ts`, remove these blocks at the top of the `describe`:

```ts
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});
```

And remove the `createSseResponse` helper function — it built `Response` objects, which we no longer consume. Replace it with this helper at the top of the file (before the `describe` block):

```ts
function sseBody(events: Array<Record<string, unknown>>): string {
	return [
		...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
		"data: [DONE]\n\n",
	].join("");
}
```

- [ ] **Step 2: Migrate "builds request body and headers according to protocol"**

Replace the entire test body with:

```ts
test("builds request body and headers according to protocol", async () => {
	let capturedUrl = "";
	let capturedHeaders: Record<string, string> = {};
	let capturedBody = "";
	let capturedSignal: AbortSignal | undefined;

	const fakeHttp = async (
		url: string,
		headers: Record<string, string>,
		body: string,
		signal: AbortSignal | undefined,
	) => {
		capturedUrl = url;
		capturedHeaders = headers;
		capturedBody = body;
		capturedSignal = signal;
		return {
			status: 200,
			bodyText: sseBody([
				{
					status: "COMPLETED",
					final: true,
					blocks: [
						{ intended_usage: "markdown_block", markdown_block: { answer: "answer text" } },
						{
							intended_usage: "web_results",
							web_result_block: {
								web_results: [
									{
										name: "Source",
										url: "https://example.com",
										snippet: "snippet",
										timestamp: "2026-02-16T10:00:00.000Z",
									},
								],
							},
						},
					],
				},
			]),
		};
	};

	const controller = new AbortController();
	const result = await searchPerplexity(
		{ query: "latest bun release notes", recency: "week", model: "pplx_pro_upgraded", incognito: true },
		"jwt-token",
		controller.signal,
		fakeHttp,
	);

	expect(capturedUrl).toBe("https://www.perplexity.ai/rest/sse/perplexity_ask");
	expect(capturedSignal).toBe(controller.signal);
	expect(capturedHeaders["Authorization"]).toBe("Bearer jwt-token");
	expect(capturedHeaders["Accept"]).toBe("text/event-stream");
	expect(capturedHeaders["X-App-ApiVersion"]).toBe("2.18");
	expect(capturedHeaders["X-Request-ID"]).toBeTruthy();

	const body = JSON.parse(capturedBody) as {
		query_str: string;
		params: {
			query_str: string;
			mode: string;
			model_preference: string;
			is_incognito: boolean;
			search_recency_filter: string | null;
			frontend_uuid: string;
			frontend_context_uuid: string;
		};
	};

	expect(body.query_str).toBe("latest bun release notes");
	expect(body.params.query_str).toBe("latest bun release notes");
	expect(body.params.mode).toBe("copilot");
	expect(body.params.model_preference).toBe("pplx_pro_upgraded");
	expect(body.params.is_incognito).toBe(true);
	expect(body.params.search_recency_filter).toBe("week");
	expect(body.params.frontend_uuid).toBeTruthy();
	expect(body.params.frontend_context_uuid).toBeTruthy();

	expect(result.answer).toBe("answer text");
	expect(result.sources).toHaveLength(1);
});
```

- [ ] **Step 3: Migrate "passes model and incognito through to request body"**

Replace with:

```ts
test("passes model and incognito through to request body", async () => {
	let capturedBody = "";
	const fakeHttp = async (
		_url: string,
		_headers: Record<string, string>,
		body: string,
	) => {
		capturedBody = body;
		return {
			status: 200,
			bodyText: sseBody([{ status: "COMPLETED", final: true, text: "answer", blocks: [] }]),
		};
	};

	await searchPerplexity(
		{ query: "q", model: "claude46sonnetthinking", incognito: false },
		"jwt-token",
		undefined,
		fakeHttp,
	);

	const body = JSON.parse(capturedBody) as {
		params: { model_preference: string; is_incognito: boolean };
	};
	expect(body.params.model_preference).toBe("claude46sonnetthinking");
	expect(body.params.is_incognito).toBe(false);
});
```

- [ ] **Step 4: Migrate "passes incognito true through to request body"**

Replace with:

```ts
test("passes incognito true through to request body", async () => {
	let capturedBody = "";
	const fakeHttp = async (_url: string, _headers: Record<string, string>, body: string) => {
		capturedBody = body;
		return {
			status: 200,
			bodyText: sseBody([{ status: "COMPLETED", final: true, text: "answer", blocks: [] }]),
		};
	};

	await searchPerplexity(
		{ query: "q", model: "pplx_pro_upgraded", incognito: true },
		"jwt-token",
		undefined,
		fakeHttp,
	);

	const body = JSON.parse(capturedBody) as { params: { is_incognito: boolean } };
	expect(body.params.is_incognito).toBe(true);
});
```

- [ ] **Step 5: Migrate "maps 401 and 403 responses to AUTH error"**

Replace with:

```ts
test("maps 401 and 403 responses to AUTH error", async () => {
	for (const status of [401, 403]) {
		const fakeHttp = async () => ({ status, bodyText: "auth fail" });
		await expect(
			searchPerplexity(
				{ query: "q", model: "pplx_pro_upgraded", incognito: true },
				"jwt",
				undefined,
				fakeHttp,
			),
		).rejects.toMatchObject({ name: "SearchError", code: "AUTH" });
	}
});
```

- [ ] **Step 6: Migrate "maps 429 responses to RATE_LIMIT error"**

Replace with:

```ts
test("maps 429 responses to RATE_LIMIT error", async () => {
	const fakeHttp = async () => ({ status: 429, bodyText: "rate limited" });
	await expect(
		searchPerplexity(
			{ query: "q", model: "pplx_pro_upgraded", incognito: true },
			"jwt",
			undefined,
			fakeHttp,
		),
	).rejects.toMatchObject({ name: "SearchError", code: "RATE_LIMIT" });
});
```

- [ ] **Step 7: Migrate "deduplicates sources by normalized URL"**

Replace with:

```ts
test("deduplicates sources by normalized URL", async () => {
	const fakeHttp = async () => ({
		status: 200,
		bodyText: sseBody([
			{
				status: "COMPLETED",
				final: true,
				blocks: [
					{ intended_usage: "markdown_block", markdown_block: { answer: "answer text" } },
					{
						intended_usage: "web_results",
						web_result_block: {
							web_results: [
								{ name: "A", url: "https://example.com/path" },
								{ name: "A duplicate", url: "https://example.com/path/" },
								{ name: "B", url: "https://another.example/path" },
							],
						},
					},
				],
			},
		]),
	});

	const result = await searchPerplexity(
		{ query: "q", model: "pplx_pro_upgraded", incognito: true },
		"jwt",
		undefined,
		fakeHttp,
	);

	expect(result.sources).toHaveLength(2);
	expect(result.sources[0].url).toBe("https://example.com/path");
	expect(result.sources[1].url).toBe("https://another.example/path");
});
```

- [ ] **Step 8: Migrate "answer extraction prioritizes markdown_block over ask_text and text"**

Open `test/search/client.test.ts` and find this test (it was truncated in the spec exploration but exists). Apply the same shape transformation as Steps 7: build a `fakeHttp` that returns `{status: 200, bodyText: sseBody([...])}` with the events from the original test, pass it as the 4th arg to `searchPerplexity`, drop the `globalThis.fetch` assignment. Preserve the original `expect()` assertions exactly.

If any other tests in this file mock `globalThis.fetch`, apply the same transformation: build a `fakeHttp` returning `{status, bodyText: sseBody([...])}` and pass it through DI. Search for `globalThis.fetch` in the file and replace every site.

- [ ] **Step 9: Run the full test file**

```bash
bun test test/search/client.test.ts
```

Expected: ALL tests in this file green. If any still fail, fix the migration. Do not move on with red tests.

- [ ] **Step 10: Run the whole suite**

```bash
bun test
```

Expected: all green across all test files. The auth, render, config, and stream tests are untouched and should be unaffected.

- [ ] **Step 11: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add test/search/client.test.ts
git commit -m "test(search): migrate client tests from globalThis.fetch to DI

Each test now constructs a fake HttpFetcher and passes it as the
4th arg to searchPerplexity. Asserts on captured {url, headers, body}
instead of RequestInit. sseBody() helper replaces createSseResponse()."
```

---

## Task 5: Detect Cloudflare challenges and surface a clear error

**Files:**
- Modify: `src/search/client.ts`
- Modify: `test/search/client.test.ts`

When the pinned Chrome profile ages out and Cloudflare starts blocking, users should see "Cloudflare blocked this request — update pi-perplexity" instead of a generic NETWORK error. Detection: status 403 AND body contains a Cloudflare challenge marker.

- [ ] **Step 1: Write the failing test**

Append to the `describe("searchPerplexity", ...)` block in `test/search/client.test.ts`:

```ts
test("recognizes a Cloudflare challenge response", async () => {
	const cfBody = '<!DOCTYPE html><html><head><title>Just a moment...</title></head>...';
	const fakeHttp = async () => ({ status: 403, bodyText: cfBody });

	await expect(
		searchPerplexity(
			{ query: "q", model: "pplx_pro_upgraded", incognito: true },
			"jwt",
			undefined,
			fakeHttp,
		),
	).rejects.toMatchObject({
		name: "SearchError",
		code: "NETWORK",
		message: expect.stringMatching(/Cloudflare/i) as unknown as string,
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/search/client.test.ts -t "Cloudflare challenge"
```

Expected: FAIL — current code returns `SearchError("AUTH", ...)` for 403, not `NETWORK` with a Cloudflare-specific message.

- [ ] **Step 3: Implement Cloudflare-challenge detection**

In `src/search/client.ts`, **insert** the following helper near the existing `mapHttpError` function:

```ts
function isCloudflareChallenge(bodyText: string): boolean {
	if (!bodyText) return false;
	const sample = bodyText.slice(0, 4096).toLowerCase();
	return (
		sample.includes("just a moment") ||
		sample.includes("cf-mitigated") ||
		sample.includes("attention required") ||
		sample.includes("cf-chl") ||
		sample.includes("cloudflare")
	);
}
```

Then in `searchPerplexity`, **before** the existing `if (httpResult.status !== 200) { throw mapHttpError(httpResult.status); }`, insert:

```ts
if (httpResult.status === 403 && isCloudflareChallenge(httpResult.bodyText)) {
	throw new SearchError(
		"NETWORK",
		"Cloudflare blocked this request. The TLS impersonation profile may be stale — update pi-perplexity, or open an issue if you're already on the latest version.",
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test test/search/client.test.ts -t "Cloudflare challenge"
```

Expected: PASS.

- [ ] **Step 5: Re-run the full suite to confirm the 401/403 AUTH test still passes**

```bash
bun test test/search/client.test.ts
```

Expected: all green. In particular, the "maps 401 and 403 responses to AUTH error" test uses body `"auth fail"`, which does not contain CF markers, so it still routes to AUTH.

- [ ] **Step 6: Commit**

```bash
git add src/search/client.ts test/search/client.test.ts
git commit -m "feat(search): detect Cloudflare challenges and surface a clear error

When status is 403 and the body contains a CF challenge marker
('Just a moment', 'cf-mitigated', etc.), throw NETWORK error with
guidance to update the package. Plain 401/403 still routes to AUTH."
```

---

## Task 6: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Edit `README.md` — Requirements section**

Change the Requirements list from:

```markdown
## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- [Bun](https://bun.sh/) runtime (available on `PATH`)
- A **Perplexity Pro** or **Max** subscription
- macOS (for zero-interaction auth) _or_ an interactive terminal (for email OTP)
```

to:

```markdown
## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- Node.js ≥ 20 (provided by pi)
- A **Perplexity Pro** or **Max** subscription
- macOS (for zero-interaction auth) _or_ an interactive terminal (for email OTP)
- Supported platforms: Windows / macOS / Linux on x64 or arm64
```

- [ ] **Step 2: Edit `README.md` — "How It Works" section**

Replace the existing two-paragraph "How It Works" section:

```markdown
## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) using your subscription credentials obtained from the macOS app or via email OTP. Responses stream as incremental events that are merged into a final result.

When pi loads extensions under Node/jiti, direct `fetch` to Perplexity gets Cloudflare-challenged, so the search client shells out to a Bun subprocess — that's the only reason Bun is required.
```

with:

```markdown
## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) using your subscription credentials obtained from the macOS app or via email OTP. Responses are buffered, parsed as SSE events, and merged into a final result.

Cloudflare TLS-fingerprints the endpoint, so Node's built-in `fetch` gets challenged. The search client uses [`node-tls-client`](https://www.npmjs.com/package/node-tls-client) — a small native module that ships prebuilt binaries per OS/arch and impersonates a recent Chrome TLS handshake — so requests pass without needing an external runtime. If Cloudflare eventually moves the goalposts, the error message will say so and a package update will be all that's needed.
```

- [ ] **Step 3: Edit `README.md` — Development section**

Replace:

```markdown
## Development

```
bun install        # Install dev dependencies
bun test           # Run tests
bunx tsc --noEmit  # Type check
```
```

with:

```markdown
## Development

End users don't need Bun. Contributors do, because the test suite uses `bun:test`:

```
bun install        # Install dev dependencies
bun test           # Run tests
bunx tsc --noEmit  # Type check
```

A future change may migrate tests to a Node-native runner; for now, Bun-on-PATH is required only for development.
```

- [ ] **Step 4: Sanity-check the README renders sensibly**

```bash
grep -n -i "bun" README.md
```

Expected output: only mentions of Bun in the Development section. No Bun in Requirements, How It Works, or anywhere else suggesting end users need it.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): bun is no longer an end-user requirement

Update Requirements, How It Works, and Development sections to
reflect node-tls-client transport and Node-only runtime needs."
```

---

## Task 7: Update CHANGELOG, design-decisions, and sweep AGENTS.md / plan.md

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/design-decisions.md`
- Modify: `AGENTS.md`
- Modify: `plan.md`

- [ ] **Step 1: Read the current CHANGELOG to find the right insertion point**

```bash
head -20 CHANGELOG.md
```

Find the topmost entry (it'll be `## [0.2.1]` or similar — confirm).

- [ ] **Step 2: Add a new CHANGELOG entry**

Insert a new entry above the topmost existing entry. Use the next minor version (e.g. if current is 0.2.1, next is 0.3.0 — confirm by reading `package.json` version). Entry content:

```markdown
## [0.3.0] - 2026-05-15

### Changed
- **End users no longer need Bun on PATH.** The search client now uses [`node-tls-client`](https://www.npmjs.com/package/node-tls-client), a small native module with prebuilt binaries per OS/arch, instead of shelling out to a Bun subprocess for Cloudflare bypass. Bun stays in `devDependencies` for the test suite only.
- Pinned Chrome TLS impersonation profile to `chrome_131`. If Cloudflare detection changes and this profile is rejected, a clear "Cloudflare blocked" error message will surface, and a package update with a newer profile will restore service.

### Added
- Detection of Cloudflare challenge responses (status 403 + CF markers in body) with a dedicated error message pointing users to update.

### Removed
- `fetchViaBunRuntime` and the Bun-subprocess code path in `src/search/client.ts`.
- `bun` from runtime `dependencies` and `engines`.

### Supported Platforms
Windows / macOS / Linux on x64 or arm64. Other platforms (e.g. musl/alpine) may not have `node-tls-client` prebuilds — please open an issue if you need one.
```

Bump `version` in `package.json` to match (e.g. `"version": "0.3.0"`).

- [ ] **Step 3: Append to `docs/design-decisions.md`**

Append the following section to `docs/design-decisions.md`:

```markdown

## Why `node-tls-client` instead of Bun subprocess, pure-Node TLS forging, or `curl-impersonate`

Cloudflare TLS-fingerprints the SSE endpoint. The transport must mimic a real browser's ClientHello (cipher order, extensions, GREASE, ALPN).

Considered:

1. **Pure-Node TLS forging** (custom undici dispatcher, manual TLS shaping). Node's `tls` module doesn't let JS reshape the handshake; it's whatever OpenSSL/BoringSSL was compiled with. Rejected as fragile and high-maintenance.
2. **`curl-impersonate` system binary subprocess.** Same UX problem as Bun: requires a separate install, painful on Windows.
3. **Bun subprocess (status quo).** Works, but makes Bun a hard end-user prerequisite for what is fundamentally one HTTP call.
4. **`node-tls-client`** (chosen). Wraps `bogdanfinn/tls-client` (Go), ships prebuilds for Win/macOS/Linux × x64/arm64 via npm. Named profiles (`chrome_131`) make version bumps cheap when Cloudflare updates detection.

Trade-offs accepted: ~10–15MB native binary inside `node_modules`, periodic profile bumps when Cloudflare updates, no support for niche platforms without prebuilds (musl/alpine, FreeBSD).

See [`docs/specs/2026-05-15-remove-bun-dependency-design.md`](specs/2026-05-15-remove-bun-dependency-design.md) for the full design.
```

- [ ] **Step 4: Sweep `AGENTS.md` for stale Bun references**

```bash
grep -n -i "bun" AGENTS.md
```

For each match, decide:
- If it's about end-user setup (e.g. "user must install Bun"), update to remove the requirement.
- If it's about contributor / test workflow, leave it (Bun is still used for tests).

Edit each match in place. If there are no matches that imply end-user Bun, no edits needed — just record `no changes needed` mentally and move on.

- [ ] **Step 5: Sweep `plan.md`**

```bash
grep -n -i "bun" plan.md
```

`plan.md` is the historical implementation plan from the project's start; it predates this change. Two acceptable approaches:

1. **Leave it as historical.** Add a one-line note at the very top: `> Note: end-user Bun requirement was removed in v0.3.0; see docs/specs/2026-05-15-remove-bun-dependency-design.md.`
2. **Edit each Bun reference** to reflect the new state.

Use approach #1 — the file is history, not living docs. Prepend the note.

- [ ] **Step 6: Run all the doc-touching checks one more time**

```bash
grep -rn -i "bun" README.md CHANGELOG.md docs/ AGENTS.md plan.md | grep -v -E "(bun:test|bun test|bun install|bun-types|devDependencies|node_modules|\.lock)"
```

Read each remaining match and confirm it's either (a) about contributor tests, or (b) intentionally historical. If a match implies end users still need Bun, fix it.

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md package.json docs/design-decisions.md AGENTS.md plan.md
git commit -m "docs: changelog, design notes, and sweep for bun-removal release

Bump to 0.3.0. Document the choice of node-tls-client. Add a historical
note to plan.md. Sweep AGENTS.md for stale references."
```

---

## Task 8: Final verification

**Files:** none modified — this task is purely verification gates.

- [ ] **Step 1: Clean install from a clean state**

```bash
rm -rf node_modules bun.lock
bun install
```

Expected: clean install, `node-tls-client` is fetched with a prebuilt binary matching the host platform. No error or warning about Bun being missing from `dependencies`.

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: all green. Test count should be roughly the same as before (we added ~5 tests and removed none).

- [ ] **Step 4: Smoke test against real Perplexity (requires cached auth)**

Assuming the user has already run `/perplexity-login` and has a cached token:

```bash
PI_PERPLEXITY_E2E=1 bun test test/e2e-models.test.ts
```

Expected: a real Perplexity search succeeds and returns an answer + sources via `node-tls-client`. If it fails with `Cloudflare blocked`, the pinned profile may need bumping — check `node-tls-client` releases for a newer Chrome profile and update `src/search/http.ts`.

If the user does not have cached auth and doesn't want to run E2E, skip this step but flag that smoke testing is recommended before publishing.

- [ ] **Step 5: Verify nothing remains in `src/` that references Bun**

```bash
grep -rn -i "bun" src/
```

Expected: zero matches. If anything matches, investigate — it's likely a stale comment or import.

- [ ] **Step 6: Final sanity diff**

```bash
git diff main --stat
```

Expected output shape:
- `src/search/client.ts` — large negative line count (Bun subprocess removed), small positive (CF detection + DI seam).
- `src/search/http.ts` — new file, ~40 lines.
- `test/search/http.test.ts` — new file.
- `test/search/client.test.ts` — modest churn (tests migrated from `fetch` mocks to DI).
- `package.json` — small.
- `bun.lock` — large (regenerated).
- `README.md`, `CHANGELOG.md`, `docs/design-decisions.md`, `plan.md`, possibly `AGENTS.md` — small.

If the stat shape is wildly different from this (e.g. dozens of source files touched), pause and review — something's off-scope.

- [ ] **Step 7: Optional — push the branch**

```bash
git push -u origin remove-bun-dep
```

Then open a PR upstream or hold for further review.

---

## Self-Review Checklist (performed inline by plan author)

- ✅ **Spec coverage:** Each spec section maps to a task — code changes (Tasks 2–5), packaging (Task 1), tests (Tasks 2, 4, 5), docs (Tasks 6, 7), verification (Task 8). Decisions A/B/C are honored throughout (Bun-only-in-devDeps, `chrome_131` pin, hard error on unsupported platforms via the natural `require()` failure).
- ✅ **No placeholders:** Every step has exact file paths, full code blocks, and concrete commands. The one inevitable ambiguity (exact `node-tls-client` API surface) is flagged in Task 2 Step 4 with explicit guidance to adjust both test and impl in lockstep.
- ✅ **Type consistency:** `HttpFetcher` and `HttpResponse` types are defined in `http.ts` (Task 2) and imported by `client.ts` (Task 3). Mock fetcher signatures in tests (Tasks 3, 4, 5) match the published type.
- ✅ **TDD discipline:** Tasks 2, 3, 4, 5 all follow failing-test-first → impl → green → commit.

---

## Execution Handoff

This plan is ready to execute. Two options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, with review between tasks. Best for catching design drift early.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, with checkpoints for review.

Which approach do you prefer?
