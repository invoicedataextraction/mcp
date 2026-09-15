// The MCP server for Invoice Data Extraction: the public API's operations as
// tools, over streamable HTTP at mcp.invoicedataextraction.com/mcp, for an
// agent whose owner has connected it with their API key. The key is the
// credential: it arrives as a bearer header, is forwarded to the API on every
// tool call and validated by that use, and is never stored or logged. The
// worker keeps no state and holds no secret of its own (src/api.js). One MCP
// server is built per request with the caller's key closed over, which is
// how the handler is meant to be used.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createApiClient } from "./api.js";
import { registerTools, SERVER_INSTRUCTIONS, SERVER_NAME } from "./tools.js";
import pkg from "../package.json";

// Not exported: the Workers runtime reads every named export of the entry
// module as a handler and refuses to start on one that is not.
const ROUTE = "/mcp";
const DOCS_URL = "https://invoicedataextraction.com/docs/mcp";
const KEYS_URL = "https://invoicedataextraction.com/dashboard?view=API";

const envelope = (status, code, message) =>
	new Response(JSON.stringify({ success: false, error: { code, message, retryable: false, details: null } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const bearerToken = (header) => {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
	return match ? match[1] : null;
};

function createServer(api) {
	const server = new McpServer({ name: SERVER_NAME, version: pkg.version }, { instructions: SERVER_INSTRUCTIONS });
	registerTools(server, api);
	return server;
}

const handlerFor = (api) =>
	createMcpHandler(() => createServer(api), {
		route: ROUTE,
		// The server is reached with a bearer key, never a cookie, so any origin
		// may call it; which hostnames reach the worker is Cloudflare's routing.
		allowedOriginHostnames: "*",
		onerror: (error) => console.error(`MCP handler error: ${error?.name}: ${error?.message}`),
	});

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Everything but the endpoint answers with the API's error envelope,
		// never bare text, as the API does for its unknown paths.
		if (url.pathname !== ROUTE) {
			return envelope(404, "NOT_FOUND", `Unknown path. The MCP server is served at ${ROUTE}. Documentation: ${DOCS_URL}`);
		}

		// A preflight carries no credentials; the handler answers it itself.
		if (request.method === "OPTIONS") {
			return handlerFor(null)(request, env, ctx);
		}

		const apiKey = bearerToken(request.headers.get("authorization"));
		if (!apiKey) {
			return envelope(
				401,
				"UNAUTHENTICATED",
				`Missing API key. Send it as "Authorization: Bearer <key>" on every request to this server; ${DOCS_URL} shows the setting for each harness. Create or view your keys at ${KEYS_URL}.`,
			);
		}
		return handlerFor(createApiClient(env, apiKey))(request, env, ctx);
	},
};
