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
					text: async () => 'data: {"final":true}\n\ndata: [DONE]\n\n',
				};
			}
			async close() {}
		}

		// Mock both Session and ClientIdentifier — ClientIdentifier is a string enum
		// whose values equal their names, so a plain object suffices.
		mock.module("node-tls-client", () => ({
			Session: FakeSession,
			ClientIdentifier: { chrome_131: "chrome_131" },
		}));

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

	test("forwards headers and body to Session.post", async () => {
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
			bodyText: 'data: {"final":true}\n\ndata: [DONE]\n\n',
		});
	});

	test("throws AbortError when signal is already aborted before call", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			postWithFingerprint("https://example.com", {}, "body", controller.signal),
		).rejects.toThrow();
		expect(sessionPostCalls).toHaveLength(0); // never made the request
	});

	test("throws AbortError if signal aborts during a slow request", async () => {
		// Override the FakeSession.post for this test to hang
		class SlowSession {
			constructor(_opts: Record<string, unknown>) {}
			async post(_url: string, _init: Record<string, unknown>) {
				await new Promise((r) => setTimeout(r, 200));
				return { status: 200, text: async () => "" };
			}
			async close() {}
		}
		mock.module("node-tls-client", () => ({
			Session: SlowSession,
			ClientIdentifier: { chrome_131: "chrome_131" },
		}));
		const mod = await import(`../../src/search/http.ts?t=${Date.now()}slow`);

		const controller = new AbortController();
		const pending = mod.postWithFingerprint("https://example.com", {}, "body", controller.signal);
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toThrow();
	});
});
