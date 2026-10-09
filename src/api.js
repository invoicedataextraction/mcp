// The one client of the public API in this worker. Every request goes through
// the `API` binding, and this worker holds no secret of its own. The
// caller's key is forwarded as it arrived, every request is tagged as this
// channel, and every answer is the API's own JSON, passed through.
import pkg from "../package.json";

const API_ORIGIN = "https://api.invoicedataextraction.com";

// Longer than the longest held status request (45 seconds), so that a hung
// origin fails loudly instead of holding the tool call open until the
// client gives up on it.
const REQUEST_TIMEOUT_MS = 60_000;
// An import downloads every attached file into the upload session inside one
// request, so it is given longer.
export const IMPORT_TIMEOUT_MS = 240_000;

const internalError = (message) => ({
	success: false,
	error: { code: "INTERNAL_ERROR", message, retryable: true, details: null },
});

// A connection made by signing in has no key its owner can paste a new one
// over, so the API's advice for a revoked key is replaced with the way back.
const RECONNECT_MESSAGE =
	"This connection to Invoice Data Extraction has ended: its key was revoked. The owner reconnects Invoice Data Extraction in this assistant, which signs them in again.";

export function createApiClient(env, apiKey, { signedIn = false } = {}) {
	async function call(method, path, { query, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
		const url = new URL(`/v1${path}`, API_ORIGIN);
		for (const [name, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
		}
		const headers = new Headers({
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"X-SDK-Name": "mcp",
			"X-SDK-Version": pkg.version,
		});
		if (body !== undefined) headers.set("Content-Type", "application/json");

		let response;
		try {
			response = await env.API.fetch(
				new Request(url, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				}),
			);
		} catch (error) {
			// An unreachable API answers with its own JSON 502 envelope; this is the
			// binding itself failing or the request timing out.
			console.error(`API call failed: ${method} ${url.pathname} -> ${error?.name}: ${error?.message}`);
			return {
				status: 502,
				data: internalError(
					"The API could not be reached. Retry after a short delay; if it keeps failing, email support@invoicedataextraction.com.",
				),
			};
		}

		const text = await response.text();
		try {
			const data = JSON.parse(text);
			if (signedIn && data?.error?.code === "API_KEY_REVOKED") data.error.message = RECONNECT_MESSAGE;
			return { status: response.status, data };
		} catch {
			console.error(`API answered non-JSON: ${method} ${url.pathname} -> ${response.status}`);
			return {
				status: response.status,
				data: internalError(
					"The API answered with something other than JSON. Retry after a short delay; if it keeps failing, email support@invoicedataextraction.com.",
				),
			};
		}
	}

	return { call };
}
