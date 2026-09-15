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

const internalError = (message) => ({
	success: false,
	error: { code: "INTERNAL_ERROR", message, retryable: true, details: null },
});

export function createApiClient(env, apiKey) {
	async function call(method, path, { query, body } = {}) {
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
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
			return { status: response.status, data: JSON.parse(text) };
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
