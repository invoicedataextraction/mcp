// The MCP server for Invoice Data Extraction: the public API's operations as
// tools, over streamable HTTP at mcp.invoicedataextraction.com/mcp. An agent
// connects in one of two ways, and both end as the same thing, an API key
// forwarded to the API on every tool call and validated by that use:
//
// - With the owner's API key as a bearer header, as harnesses that take a
//   header do. The key is never stored or logged.
// - By signing in (OAuth), as assistants such as ChatGPT and Claude do: the
//   owner signs in on the website and approves the client, an API key is
//   created for them, and it is kept encrypted in the grant (src/connect.js).
//
// One MCP server is built per request with the caller's key closed over, which
// is how the handler is meant to be used.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createApiClient } from "./api.js";
import { authorize, callback, handoff, AUTHORIZE_PATH, CALLBACK_PATH, HANDOFF_PATH, reportUnreturned } from "./connect.js";
import { registerTools, SERVER_INSTRUCTIONS, SERVER_NAME } from "./tools.js";
import pkg from "../package.json";

// Not exported: the Workers runtime reads every named export of the entry
// module as a handler and refuses to start on one that is not.
const ROUTE = "/mcp";
const DOCS_URL = "https://invoicedataextraction.com/docs/mcp";
const KEYS_URL = "https://invoicedataextraction.com/dashboard?view=API";
const API_KEY_PREFIX = "ide_";
// A connection is kept while it is used: each refresh moves its expiry this far
// out. A year, so that an owner who extracts once a quarter or once a year is
// never asked to sign in again.
const CONNECTION_IDLE_SECONDS = 365 * 24 * 60 * 60;

const envelope = (status, code, message, headers = new Headers()) => {
	headers.set("Content-Type", "application/json");
	headers.delete("Content-Length");
	return new Response(JSON.stringify({ success: false, error: { code, message, retryable: false, details: null } }), {
		status,
		headers,
	});
};

function createServer(api) {
	const server = new McpServer({ name: SERVER_NAME, version: pkg.version }, { instructions: SERVER_INSTRUCTIONS });
	registerTools(server, api);
	return server;
}

const handlerFor = (api) =>
	createMcpHandler(() => createServer(api), {
		route: ROUTE,
		// The server is reached with a bearer credential, never a cookie, so any
		// origin may call it; which hostnames reach the worker is Cloudflare's routing.
		allowedOriginHostnames: "*",
		onerror: (error) => console.error(`MCP handler error: ${error?.name}: ${error?.message}`),
	});

// Every request under /mcp arrives here authenticated, with the caller's API
// key in ctx.props, whichever way they connected. A preflight carries no
// credentials and is answered by the handler itself.
const mcpApi = {
	fetch: (request, env, ctx) =>
		handlerFor(ctx.props?.apiKey ? createApiClient(env, ctx.props.apiKey, { signedIn: ctx.props.signedIn === true }) : null)(
			request,
			env,
			ctx,
		),
};

// Everything that is not /mcp or the provider's own OAuth endpoints.
const site = {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === AUTHORIZE_PATH) return authorize(request, env);
		if (pathname === HANDOFF_PATH) return handoff(request, env);
		if (pathname === CALLBACK_PATH) return callback(request, env);
		// Everything else answers with the API's error envelope, never bare text,
		// as the API does for its unknown paths.
		return envelope(404, "NOT_FOUND", `Unknown path. The MCP server is served at ${ROUTE}. Documentation: ${DOCS_URL}`);
	},
};

// Built on the first request, once the resource's address is known from the environment.
let provider;
const providerFor = (env) =>
	(provider ??= new OAuthProvider({
		apiRoute: ROUTE,
		apiHandler: mcpApi,
		defaultHandler: site,
		authorizeEndpoint: AUTHORIZE_PATH,
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		clientIdMetadataDocumentEnabled: true,
		resourceMetadata: {
			resource: env.MCP_RESOURCE,
			authorization_servers: [new URL(env.MCP_RESOURCE).origin],
			bearer_methods_supported: ["header"],
			resource_name: "Invoice Data Extraction",
		},
		refreshTokenTTL: CONNECTION_IDLE_SECONDS,
		refreshTokenIdleTTL: CONNECTION_IDLE_SECONDS,
		// A registered client is renewed only on a token request in the second
		// half of its life, so it is kept twice as long as a connection may idle;
		// otherwise the client would lapse before the connection it holds.
		clientRegistrationTTL: 2 * CONNECTION_IDLE_SECONDS,
		// An API key sent as the bearer header is passed through as it is; the
		// API validates it on the first tool call, as it always has.
		resolveExternalToken: async ({ token, env: tokenEnv }) =>
			token.startsWith(API_KEY_PREFIX) ? { props: { apiKey: token }, audience: tokenEnv.MCP_RESOURCE } : null,
	}));

export default {
	// The scheduled sweep: a connection whose browser never finished it is
	// logged as an error.
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(reportUnreturned(env));
	},

	async fetch(request, env, ctx) {
		const response = await providerFor(env).fetch(request, env, ctx);
		// A request to /mcp without a usable credential keeps the provider's
		// challenge headers, which tell an assistant how to sign in, and gets a
		// body that tells a person or an agent with a key what to send.
		if (response.status === 401 && new URL(request.url).pathname === ROUTE) {
			return envelope(
				401,
				"UNAUTHENTICATED",
				`Not signed in, or the sign-in has expired. Assistants that support sign-in open the Invoice Data Extraction sign-in page when they connect; otherwise send your API key as "Authorization: Bearer <key>" on every request to this server. ${DOCS_URL} shows the setting for each harness. Create or view your keys at ${KEYS_URL}.`,
				new Headers(response.headers),
			);
		}
		return response;
	},
};
