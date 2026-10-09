// The sign-in, end to end as an assistant drives it: discovery, registration,
// the authorization request, the website's handoff and the browser's return,
// the token exchange, and a tool call made with the token that reaches the API
// with the owner's key.
import { describe, it, expect } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { reportUnreturned } from "../src/connect.js";
import { callWorker, envWith, ORIGIN } from "./client.js";
import { mockApi, ok, apiError } from "./mockApi.js";

const SECRET = "test-connect-secret";
const SITE = "https://invoicedataextraction.com";
const CLIENT_REDIRECT = "https://assistant.example/oauth/callback";
const OWNER_KEY = `ide_${"ab".repeat(32)}`;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

// The browser's binding cookies, carried from one response to the next request.
const cookiesFrom = (response) =>
	response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");

async function register(env) {
	const response = await callWorker(
		"/register",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Example Assistant",
				redirect_uris: [CLIENT_REDIRECT],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			}),
		},
		env,
	);
	expect(response.status).toBe(201);
	return (await response.json()).client_id;
}

// From the client's authorization request to the website's connect page.
async function startSignIn(env) {
	const clientId = await register(env);
	const { verifier, challenge } = await pkce();
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: CLIENT_REDIRECT,
		state: "client-state",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	});
	const response = await callWorker(`/authorize?${query}`, { redirect: "manual" }, env);
	expect(response.status).toBe(302);
	return { clientId, verifier, connectPage: new URL(response.headers.get("Location")), cookie: cookiesFrom(response) };
}

async function handOff(env, { secret = SECRET, body = { api_key: OWNER_KEY, user_id: "user_owner" } } = {}) {
	return callWorker(
		"/connect/handoff",
		{ method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		env,
	);
}

describe("discovery", () => {
	it("challenges a request without a credential with where to sign in, and tells a person what to send", async () => {
		const response = await callWorker("/mcp", { method: "POST" });
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
		const body = await response.json();
		expect(body.error.code).toBe("UNAUTHENTICATED");
		expect(body.error.message).toContain("Authorization: Bearer");
	});

	it("publishes the resource and the authorization server, with registration and client metadata documents", async () => {
		const resource = await (await callWorker("/.well-known/oauth-protected-resource/mcp")).json();
		expect(resource.resource).toBe(`${ORIGIN}/mcp`);
		expect(resource.authorization_servers).toEqual([ORIGIN]);

		const server = await (await callWorker("/.well-known/oauth-authorization-server")).json();
		expect(server.issuer).toBe(ORIGIN);
		expect(server.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
		expect(server.token_endpoint).toBe(`${ORIGIN}/token`);
		expect(server.registration_endpoint).toBe(`${ORIGIN}/register`);
		expect(server.code_challenge_methods_supported).toContain("S256");
		expect(server.client_id_metadata_document_supported).toBe(true);
	});
});

describe("signing in", () => {
	it("sends the owner to the connect page with what the page must show, and nothing reaches the API", async () => {
		const api = mockApi();
		const env = envWith({ API: api });
		const { connectPage, cookie } = await startSignIn(env);
		expect(connectPage.origin + connectPage.pathname).toBe(`${SITE}/connect`);
		expect(connectPage.searchParams.get("state")).toBeTruthy();
		expect(connectPage.searchParams.get("client")).toBe("Example Assistant");
		expect(connectPage.searchParams.get("to")).toBe("assistant.example");
		expect(connectPage.searchParams.get("local")).toBeNull();
		expect(connectPage.searchParams.get("utm_source")).toBe("assistant_connect");
		expect(cookie).toContain("__Host-ide-connect_");
		expect(api.calls).toHaveLength(0);
	});

	it("connects: the handed-off key becomes the grant, and a tool call with the token reaches the API with the owner's key", async () => {
		const api = mockApi();
		const env = envWith({ API: api });
		const { clientId, verifier, connectPage, cookie } = await startSignIn(env);

		const handoff = await handOff(env);
		expect(handoff.status).toBe(200);
		const { code } = await handoff.json();

		const back = await callWorker(
			`/connect/callback?state=${encodeURIComponent(connectPage.searchParams.get("state"))}&code=${code}`,
			{ redirect: "manual", headers: { Cookie: cookie } },
			env,
		);
		expect(back.status).toBe(302);
		const toClient = new URL(back.headers.get("Location"));
		expect(toClient.origin + toClient.pathname).toBe(CLIENT_REDIRECT);
		expect(toClient.searchParams.get("state")).toBe("client-state");
		expect(toClient.searchParams.get("iss")).toBe(ORIGIN);

		const tokens = await callWorker(
			"/token",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: toClient.searchParams.get("code"),
					redirect_uri: CLIENT_REDIRECT,
					client_id: clientId,
					code_verifier: verifier,
				}),
			},
			env,
		);
		expect(tokens.status).toBe(200);
		const { access_token, refresh_token } = await tokens.json();
		expect(access_token).toBeTruthy();
		expect(refresh_token).toBeTruthy();

		api.reply(ok({ success: true, credits_balance: 120, credits_reserved: 0 }));
		const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
			fetch: (input, init) => worker.fetch(new Request(input, init), env, createExecutionContext()),
		});
		const client = new Client({ name: "assistant", version: "0.0.0" });
		await client.connect(transport);
		await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(api.calls).toHaveLength(1);
		expect(api.calls[0].headers.authorization).toBe(`Bearer ${OWNER_KEY}`);

		// The owner revokes the key in the dashboard: the assistant is told to reconnect, not to paste a new key.
		api.reply(apiError(401, "API_KEY_REVOKED", "This API key has been revoked. Create a new key and use it instead."));
		const revoked = await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(revoked.isError).toBe(true);
		const text = revoked.content.map((part) => part.text).join("");
		expect(text).toContain("reconnects Invoice Data Extraction in this assistant, which signs them in again");
		expect(text).not.toContain("Create a new key");
	});

	it("tells the client the owner declined, with its state", async () => {
		const env = envWith({ API: mockApi() });
		const { connectPage, cookie } = await startSignIn(env);
		const back = await callWorker(
			`/connect/callback?state=${encodeURIComponent(connectPage.searchParams.get("state"))}&error=access_denied`,
			{ redirect: "manual", headers: { Cookie: cookie } },
			env,
		);
		const toClient = new URL(back.headers.get("Location"));
		expect(toClient.origin + toClient.pathname).toBe(CLIENT_REDIRECT);
		expect(toClient.searchParams.get("error")).toBe("access_denied");
		expect(toClient.searchParams.get("state")).toBe("client-state");
	});

	it("sends a browser that did not start the sign-in, or comes back with no usable code, to the connect page", async () => {
		const env = envWith({ API: mockApi() });
		const { connectPage, cookie } = await startSignIn(env);
		const state = encodeURIComponent(connectPage.searchParams.get("state"));
		const { code } = await (await handOff(env)).json();

		const otherBrowser = await callWorker(`/connect/callback?state=${state}&code=${code}`, { redirect: "manual" }, env);
		expect(otherBrowser.headers.get("Location")).toBe(`${SITE}/connect?error=expired`);

		const noCode = await callWorker(`/connect/callback?state=${state}&code=unknown`, { redirect: "manual", headers: { Cookie: cookie } }, env);
		expect(noCode.headers.get("Location")).toBe(`${SITE}/connect?error=expired`);
	});

	it("reports, once, a handoff whose browser never finished the connection, and not one that did", async () => {
		const env = envWith({ API: mockApi() });
		const { connectPage, cookie } = await startSignIn(env);
		const { code } = await (await handOff(env, { body: { api_key: OWNER_KEY, user_id: "user_returned" } })).json();
		await callWorker(
			`/connect/callback?state=${encodeURIComponent(connectPage.searchParams.get("state"))}&code=${code}`,
			{ redirect: "manual", headers: { Cookie: cookie } },
			env,
		);
		await handOff(env, { body: { api_key: OWNER_KEY, user_id: "user_stranded" } });

		expect(await reportUnreturned(env)).not.toContain("user_stranded");
		const later = Date.now() + 11 * 60 * 1000;
		const reported = await reportUnreturned(env, later);
		expect(reported).toContain("user_stranded");
		expect(reported).not.toContain("user_returned");
		expect(await reportUnreturned(env, later)).not.toContain("user_stranded");
	});

	it("connects even when the storage refuses the marker, which only observes", async () => {
		const base = envWith({ API: mockApi() });
		const kv = base.OAUTH_KV;
		const refuseMarkers = new Proxy(kv, {
			get(target, prop) {
				const value = target[prop];
				if (prop === "put" || prop === "delete") {
					return (key, ...rest) =>
						key.startsWith("connect-unreturned:") ? Promise.reject(new Error("storage unavailable")) : value.call(target, key, ...rest);
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const env = { ...base, OAUTH_KV: refuseMarkers };
		const { connectPage, cookie } = await startSignIn(env);
		const handoff = await handOff(env, { body: { api_key: OWNER_KEY, user_id: "user_unmarked" } });
		expect(handoff.status).toBe(200);
		const { code } = await handoff.json();
		const back = await callWorker(
			`/connect/callback?state=${encodeURIComponent(connectPage.searchParams.get("state"))}&code=${code}`,
			{ redirect: "manual", headers: { Cookie: cookie } },
			env,
		);
		expect(new URL(back.headers.get("Location")).origin + new URL(back.headers.get("Location")).pathname).toBe(CLIENT_REDIRECT);
	});

	it("reports the owner of a browser that came back after the handed-off key had lapsed", async () => {
		const env = envWith({ API: mockApi() });
		const { connectPage, cookie } = await startSignIn(env);
		const { code } = await (await handOff(env, { body: { api_key: OWNER_KEY, user_id: "user_late" } })).json();
		const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`id:${code}`))), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		await env.OAUTH_KV.delete(`connect-handoff:${id}`);
		const back = await callWorker(
			`/connect/callback?state=${encodeURIComponent(connectPage.searchParams.get("state"))}&code=${code}`,
			{ redirect: "manual", headers: { Cookie: cookie } },
			env,
		);
		expect(back.headers.get("Location")).toBe(`${SITE}/connect?error=expired`);
		expect(await reportUnreturned(env, Date.now() + 11 * 60 * 1000)).toContain("user_late");
	});

	it("refuses a handoff without the shared secret or with a malformed key", async () => {
		const env = envWith({ API: mockApi() });
		expect((await handOff(env, { secret: "wrong" })).status).toBe(401);
		expect((await handOff(env, { body: { api_key: "not-a-key", user_id: "user_owner" } })).status).toBe(400);
		expect((await callWorker("/connect/handoff", {}, env)).status).toBe(405);
	});

	it("sends an authorization request it cannot trust to the connect page instead of to its redirect address", async () => {
		const response = await callWorker(
			`/authorize?${new URLSearchParams({ response_type: "code", client_id: "unknown-client", redirect_uri: "https://elsewhere.example/cb", state: "s" })}`,
			{ redirect: "manual" },
		);
		expect(response.headers.get("Location")).toBe(`${SITE}/connect?error=invalid_request`);
	});
});
