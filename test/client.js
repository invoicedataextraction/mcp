// An MCP client wired straight into the worker's fetch handler, so the tests
// speak the real protocol (discovery, tools/list, tools/call) end to end.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";

export const ORIGIN = "https://mcp.invoicedataextraction.com";
export const KEY = "ide_test_key_1234567890";

export async function callWorker(path, init = {}, env = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

export async function connect(api, { key = KEY } = {}) {
	const env = { API: api };
	const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
		requestInit: { headers: { Authorization: `Bearer ${key}` } },
		fetch: (input, init) => worker.fetch(new Request(input, init), env, createExecutionContext()),
	});
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await client.connect(transport);
	return client;
}

export const parse = (callResult) => JSON.parse(callResult.content[0].text);
