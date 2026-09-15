import { describe, it, expect } from "vitest";
import { callWorker, connect, KEY, parse } from "./client.js";
import { mockApi, ok, apiError } from "./mockApi.js";
import pkg from "../package.json";
import * as entry from "../src/index.js";

describe("the entry module", () => {
	it("exports the handler and nothing else, which the Workers runtime requires to start", () => {
		expect(Object.keys(entry)).toEqual(["default"]);
	});
});

describe("the endpoint", () => {
	it("answers unknown paths with the API's JSON envelope, never bare text", async () => {
		for (const path of ["/", "/mcp/", "/v1/extractions", "/other"]) {
			const response = await callWorker(path);
			expect(response.status).toBe(404);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			const body = await response.json();
			expect(body.success).toBe(false);
			expect(body.error.code).toBe("NOT_FOUND");
			expect(body.error.message).toContain("/docs/mcp");
		}
	});

	it("refuses a request without a bearer key before anything reaches the API", async () => {
		const api = mockApi();
		for (const headers of [{}, { Authorization: "Basic abc" }, { Authorization: "Bearer" }, { Authorization: "Bearer " }]) {
			const response = await callWorker("/mcp", { method: "POST", headers }, { API: api });
			expect(response.status).toBe(401);
			const body = await response.json();
			expect(body.error.code).toBe("UNAUTHENTICATED");
			expect(body.error.message).toContain("Authorization: Bearer");
			expect(body.error.message).toContain("dashboard?view=API");
		}
		expect(api.calls).toHaveLength(0);
	});

	it("answers a CORS preflight without a key", async () => {
		const response = await callWorker("/mcp", { method: "OPTIONS", headers: { Origin: "https://example.com" } });
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});
});

describe("discovery and the tool list", () => {
	it("identifies the server and lists the twelve tools with their annotations", async () => {
		const client = await connect(mockApi());
		expect(client.getServerVersion()).toMatchObject({ name: "invoice-data-extraction", version: pkg.version });
		expect(client.getInstructions()).toContain("create_upload_session");
		expect(client.getInstructions()).toContain("https://invoicedataextraction.com/docs/mcp.md");

		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(
			[
				"answer_extraction_questions",
				"cancel_extraction",
				"complete_file_uploads",
				"create_upload_session",
				"get_credits_balance",
				"get_extraction",
				"get_extraction_results",
				"get_output_download_url",
				"get_upload_part_urls",
				"list_extractions",
				"run_extraction",
				"submit_extraction",
			].sort(),
		);
		for (const tool of tools) {
			expect(tool.title, tool.name).toBeTruthy();
			expect(tool.description.length, tool.name).toBeGreaterThan(40);
			for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
				expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
			}
			expect(tool.annotations.openWorldHint, tool.name).toBe(false);
		}
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		const readOnly = [
			"get_credits_balance",
			"get_extraction",
			"get_extraction_results",
			"get_output_download_url",
			"get_upload_part_urls",
			"list_extractions",
		];
		for (const name of readOnly) expect(byName[name].annotations.readOnlyHint, name).toBe(true);
		for (const name of Object.keys(byName).filter((n) => !readOnly.includes(n))) {
			expect(byName[name].annotations.readOnlyHint, name).toBe(false);
		}
		expect(byName.cancel_extraction.annotations.destructiveHint).toBe(true);
		for (const name of Object.keys(byName).filter((n) => n !== "cancel_extraction")) {
			expect(byName[name].annotations.destructiveHint, name).toBe(false);
		}
		expect(byName.get_credits_balance.inputSchema.properties ?? {}).toEqual({});
		expect(byName.submit_extraction.inputSchema.required).toEqual(
			expect.arrayContaining(["upload_session_id", "file_ids", "task_name", "prompt", "output_structure"]),
		);
		await client.close();
	});
});

describe("forwarding to the API", () => {
	it("sends the caller's key, the channel headers and the path of the operation", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, credits_balance: 50, credits_reserved: 0 }));
		const client = await connect(api);
		const res = await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(res.isError).toBeFalsy();
		expect(parse(res)).toEqual({ success: true, credits_balance: 50, credits_reserved: 0 });
		expect(api.calls).toHaveLength(1);
		const [call] = api.calls;
		expect(call.method).toBe("GET");
		expect(call.url.origin).toBe("https://api.invoicedataextraction.com");
		expect(call.url.pathname).toBe("/v1/credits/balance");
		expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(call.headers["x-sdk-name"]).toBe("mcp");
		expect(call.headers["x-sdk-version"]).toBe(pkg.version);
		await client.close();
	});

	it("hands the API's error envelope back as it is, marked as an error", async () => {
		const api = mockApi();
		api.reply(
			apiError(
				401,
				"UNAUTHENTICATED",
				"Missing or invalid API key. Send it as a Bearer token in the Authorization header. Create or view your keys at https://invoicedataextraction.com/dashboard?view=API.",
			),
		);
		const client = await connect(api);
		const res = await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(res.isError).toBe(true);
		expect(parse(res)).toEqual({
			success: false,
			error: { code: "UNAUTHENTICATED", message: expect.stringContaining("Bearer token"), retryable: false, details: null },
		});
		await client.close();
	});

	it("turns a non-JSON answer into a retryable INTERNAL_ERROR envelope", async () => {
		const api = mockApi();
		api.reply({ status: 502, text: "<html>Bad gateway</html>" });
		const client = await connect(api);
		const res = await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(res.isError).toBe(true);
		const body = parse(res);
		expect(body.error.code).toBe("INTERNAL_ERROR");
		expect(body.error.retryable).toBe(true);
		await client.close();
	});

	it("turns a failed binding call into a retryable INTERNAL_ERROR envelope", async () => {
		const api = { calls: [], fetch: async () => { throw new TypeError("binding unavailable"); } };
		const client = await connect(api);
		const res = await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(res.isError).toBe(true);
		const body = parse(res);
		expect(body.error.code).toBe("INTERNAL_ERROR");
		expect(body.error.retryable).toBe(true);
		expect(body.error.message).toContain("could not be reached");
		await client.close();
	});

	it("never lets the key into a tool result", async () => {
		const api = mockApi();
		api.reply(apiError(500, "INTERNAL_ERROR", "Something went wrong on our side.", { retryable: true }));
		const client = await connect(api);
		const res = await client.callTool({ name: "get_credits_balance", arguments: {} });
		expect(JSON.stringify(res)).not.toContain(KEY);
		await client.close();
	});

	it("refuses arguments the schema rejects without calling the API", async () => {
		const api = mockApi();
		const client = await connect(api);
		const res = await client.callTool({ name: "get_extraction", arguments: { extraction_id: "abc", wait: 90 } });
		expect(res.isError).toBe(true);
		expect(api.calls).toHaveLength(0);
		await client.close();
	});
});
