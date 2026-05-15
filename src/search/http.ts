import { Session, ClientIdentifier, initTLS } from "node-tls-client";

export interface HttpResponse {
	status: number;
	bodyText: string;
}

let sessionPromise: Promise<InstanceType<typeof Session>> | null = null;

function getSession(): Promise<InstanceType<typeof Session>> {
	if (!sessionPromise) {
		sessionPromise = (async () => {
			await initTLS();
			return new Session({ clientIdentifier: ClientIdentifier.chrome_131 });
		})();
	}
	return sessionPromise;
}

/**
 * POST `body` to `url` with a Chrome TLS fingerprint (via node-tls-client).
 * Returns the buffered response (status + full body text).
 *
 * AbortSignal is honored at the caller boundary via Promise.race — node-tls-client
 * v2.1.0 has no native abort support, so the underlying request may continue in
 * the background after abort, but the returned promise rejects immediately.
 */
export async function postWithFingerprint(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal | undefined,
): Promise<HttpResponse> {
	if (signal?.aborted) {
		throw new DOMException("The request was aborted.", "AbortError");
	}

	const session = await getSession();
	const postPromise: Promise<HttpResponse> = session
		.post(url, { headers, body })
		.then(async (response) => ({
			status: response.status,
			bodyText: await response.text(),
		}));

	if (!signal) {
		return postPromise;
	}

	return await new Promise<HttpResponse>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new DOMException("The request was aborted.", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		postPromise.then(
			(res) => {
				signal.removeEventListener("abort", onAbort);
				resolve(res);
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err as Error);
			},
		);
	});
}
