import { beforeEach, describe, expect, test } from "bun:test";

import { SearchError } from "../../src/search/types.js";
import type { HttpFetcher } from "../../src/search/client.js";

let searchPerplexity: typeof import("../../src/search/client.js").searchPerplexity;

function sseBody(events: Array<Record<string, unknown>>): string {
	return [
		...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
		"data: [DONE]\n\n",
	].join("");
}

describe("searchPerplexity", () => {
	beforeEach(async () => {
		const mod = await import(`../../src/search/client.ts?t=${Date.now()}`);
		searchPerplexity = mod.searchPerplexity;
	});

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

	test("answer extraction prioritizes markdown_block over ask_text and text", async () => {
		const fakeHttp = async () => ({
			status: 200,
			bodyText: sseBody([
				{
					status: "COMPLETED",
					final: true,
					text: "fallback text",
					blocks: [
						{ intended_usage: "ask_text", markdown_block: { answer: "ask text" } },
						{ intended_usage: "markdown_block", markdown_block: { answer: "markdown answer" } },
					],
					sources_list: [{ title: "S", url: "https://example.com" }],
				},
			]),
		});

		const result = await searchPerplexity(
			{ query: "q", model: "pplx_pro_upgraded", incognito: true },
			"jwt",
			undefined,
			fakeHttp,
		);
		expect(result.answer).toBe("markdown answer");
	});

	test("answer extraction falls back to ask_text then text", async () => {
		const fakeHttpAskText = async () => ({
			status: 200,
			bodyText: sseBody([
				{
					status: "COMPLETED",
					final: true,
					text: "fallback text",
					blocks: [
						{ intended_usage: "ask_text", markdown_block: { answer: "ask answer" } },
					],
					sources_list: [{ title: "S", url: "https://example.com" }],
				},
			]),
		});

		const askTextResult = await searchPerplexity(
			{ query: "q", model: "pplx_pro_upgraded", incognito: true },
			"jwt",
			undefined,
			fakeHttpAskText,
		);
		expect(askTextResult.answer).toBe("ask answer");

		const fakeHttpText = async () => ({
			status: 200,
			bodyText: sseBody([
				{
					status: "COMPLETED",
					final: true,
					text: "text fallback",
					sources_list: [{ title: "S", url: "https://example.com" }],
				},
			]),
		});

		const textResult = await searchPerplexity(
			{ query: "q", model: "pplx_pro_upgraded", incognito: true },
			"jwt",
			undefined,
			fakeHttpText,
		);
		expect(textResult.answer).toBe("text fallback");
	});

	test("uses the injected http fetcher instead of node-tls-client when provided", async () => {
		const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
		const fakeHttp: HttpFetcher = async (url, headers, body) => {
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

	test("returns EMPTY error when response has no answer and no sources", async () => {
		const fakeHttp = async () => ({
			status: 200,
			bodyText: sseBody([{ status: "COMPLETED", final: true }]),
		});
		await expect(
			searchPerplexity(
				{ query: "q", model: "pplx_pro_upgraded", incognito: true },
				"jwt",
				undefined,
				fakeHttp,
			),
		).rejects.toMatchObject({ name: "SearchError", code: "EMPTY" });
	});

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
});
