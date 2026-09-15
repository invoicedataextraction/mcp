// A stand-in for the `API` binding: `env.API.fetch` records
// every request the worker makes and answers with what the test scripted, so
// each test states the API's response and asserts the request that reached it.
export function mockApi() {
	const calls = [];
	let script = [];
	return {
		calls,
		// Queue the responses in the order the worker will ask for them; a
		// function receives the recorded call and returns a response.
		reply(...responses) {
			script = responses;
		},
		async fetch(request) {
			const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
			const call = {
				method: request.method,
				url: new URL(request.url),
				headers: Object.fromEntries(request.headers.entries()),
				body: body ? JSON.parse(body) : null,
			};
			calls.push(call);
			const next = script.shift();
			if (!next) throw new Error(`Unscripted API call: ${call.method} ${call.url.pathname}`);
			const value = typeof next === "function" ? next(call) : next;
			if (value instanceof Response) return value;
			// A bare object is the JSON body of a 200; { status, json } or { status, text } says more.
			const scripted = "json" in value || "text" in value;
			const { status = 200, json = scripted ? undefined : value, text } = value;
			return text !== undefined
				? new Response(text, { status, headers: { "Content-Type": "text/html" } })
				: new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
		},
	};
}

export const ok = (json, status = 200) => ({ status, json });
export const apiError = (status, code, message, extra = {}) => ({
	status,
	json: { success: false, error: { code, message, retryable: false, details: null, ...extra } },
});
