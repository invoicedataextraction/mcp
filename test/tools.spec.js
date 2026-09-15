import { describe, it, expect } from "vitest";
import { connect, parse } from "./client.js";
import { mockApi, ok, apiError } from "./mockApi.js";
import { RESULT_CHAR_CAP, withoutSuccessfulPages } from "../src/results.js";

const SESSION = { success: true, upload_session_id: "sess_1", files: [] };
const partUrls = (fileId, n) => ({
	success: true,
	upload_session_id: "sess_1",
	file_id: fileId,
	file_name: `${fileId}.pdf`,
	part_size: 8388608,
	part_urls: Array.from({ length: n }, (_, i) => ({ part_number: i + 1, url: `https://storage.example.com/${fileId}/${i + 1}?X-Amz-Signature=abc` })),
});

async function call(api, name, args) {
	const client = await connect(api);
	try {
		const res = await client.callTool({ name, arguments: args });
		return { res, body: parse(res) };
	} finally {
		await client.close();
	}
}

describe("create_upload_session", () => {
	it("creates the session and fetches every file's part addresses, with generated ids when omitted", async () => {
		const api = mockApi();
		api.reply(
			(c) => ok({ success: true, upload_session_id: c.body.upload_session_id, files: c.body.files.map((f) => ({ file_id: f.file_id, file_name: f.file_name, part_size: 8388608 })) }),
			partUrls("file_1", 1),
			partUrls("big", 3),
		);
		const { res, body } = await call(api, "create_upload_session", {
			files: [
				{ file_name: "invoice-1.pdf", file_size_bytes: 120450 },
				{ file_id: "big", file_name: "large.pdf", file_size_bytes: 20_000_000 },
			],
		});
		expect(res.isError).toBeFalsy();
		const sessionId = api.calls[0].body.upload_session_id;
		expect(sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
		expect(api.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
			"POST /v1/uploads/sessions",
			`POST /v1/uploads/sessions/${sessionId}/parts`,
			`POST /v1/uploads/sessions/${sessionId}/parts`,
		]);
		expect(api.calls[0].body.files).toEqual([
			{ file_id: "file_1", file_name: "invoice-1.pdf", file_size_bytes: 120450 },
			{ file_id: "big", file_name: "large.pdf", file_size_bytes: 20_000_000 },
		]);
		expect(api.calls[1].body).toEqual({ file_id: "file_1", part_numbers: [1] });
		expect(api.calls[2].body).toEqual({ file_id: "big", part_numbers: [1, 2, 3] });
		expect(body.upload_session_id).toBe(api.calls[0].body.upload_session_id);
		expect(body.files[0]).toMatchObject({ file_id: "file_1", part_size: 8388608, total_parts: 1 });
		expect(body.files[0].part_urls).toHaveLength(1);
		expect(body.files[1]).toMatchObject({ file_id: "big", total_parts: 3 });
		expect(body.files[1].part_urls).toHaveLength(3);
		expect(body.upload_instructions).toContain("ETag");
		expect(body.next_steps).toContain("complete_file_uploads");
	});

	it("keeps the session id the caller chose, so a retry returns the same session", async () => {
		const api = mockApi();
		api.reply(ok({ ...SESSION, upload_session_id: "my-session", files: [{ file_id: "a", file_name: "a.pdf", part_size: 8388608 }] }), partUrls("a", 1));
		await call(api, "create_upload_session", { upload_session_id: "my-session", files: [{ file_id: "a", file_name: "a.pdf", file_size_bytes: 10 }] });
		expect(api.calls[0].body.upload_session_id).toBe("my-session");
		expect(api.calls[1].url.pathname).toBe("/v1/uploads/sessions/my-session/parts");
	});

	it("passes a refused session through as an error and asks for nothing else", async () => {
		const api = mockApi();
		api.reply(apiError(402, "INSUFFICIENT_CREDITS", "Not enough credits for this upload session.", { details: { credits_balance: 0, credits_reserved: 0 } }));
		const { res, body } = await call(api, "create_upload_session", { files: [{ file_name: "a.pdf", file_size_bytes: 10 }] });
		expect(res.isError).toBe(true);
		expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
		expect(api.calls).toHaveLength(1);
	});

	it("reports a file whose addresses could not be issued beside the ones that were", async () => {
		const api = mockApi();
		api.reply(
			ok({ ...SESSION, files: [{ file_id: "a", file_name: "a.pdf", part_size: 8388608 }, { file_id: "b", file_name: "b.pdf", part_size: 8388608 }] }),
			partUrls("a", 1),
			apiError(409, "FILE_NOT_UPLOADABLE", "This file has already been completed or aborted."),
		);
		const { res, body } = await call(api, "create_upload_session", {
			files: [{ file_id: "a", file_name: "a.pdf", file_size_bytes: 10 }, { file_id: "b", file_name: "b.pdf", file_size_bytes: 10 }],
		});
		expect(res.isError).toBeFalsy();
		expect(body.files[0].part_urls).toHaveLength(1);
		expect(body.files[1].part_urls).toBeUndefined();
		expect(body.files[1].part_urls_error.code).toBe("FILE_NOT_UPLOADABLE");
	});

	it("returns the session without addresses above the file limit and says what to do", async () => {
		const api = mockApi();
		const files = Array.from({ length: 101 }, (_, i) => ({ file_name: `f${i}.pdf`, file_size_bytes: 10 }));
		api.reply((c) => ok({ success: true, upload_session_id: c.body.upload_session_id, files: c.body.files.map((f) => ({ ...f, part_size: 8388608 })) }));
		const { body } = await call(api, "create_upload_session", { files });
		expect(api.calls).toHaveLength(1);
		expect(body.files).toHaveLength(101);
		expect(body.files[0].part_urls).toBeUndefined();
		expect(body.next_steps).toContain("get_upload_part_urls");
	});
});

describe("get_upload_part_urls and complete_file_uploads", () => {
	it("asks for the part addresses of one file", async () => {
		const api = mockApi();
		api.reply(partUrls("a", 2));
		const { body } = await call(api, "get_upload_part_urls", { upload_session_id: "sess_1", file_id: "a", part_numbers: [1, 2] });
		expect(api.calls[0].url.pathname).toBe("/v1/uploads/sessions/sess_1/parts");
		expect(api.calls[0].body).toEqual({ file_id: "a", part_numbers: [1, 2] });
		expect(body.part_urls).toHaveLength(2);
	});

	it("completes each file in turn and reports the ones that failed beside the ones that completed", async () => {
		const api = mockApi();
		api.reply(
			ok({ success: true, upload_session_id: "sess_1", file_id: "a", file_name: "a.pdf" }),
			apiError(422, "OBJECT_SIZE_MISMATCH", "The uploaded bytes do not match the file_size_bytes declared.", { details: { declared: 10, uploaded: 12 } }),
		);
		const { res, body } = await call(api, "complete_file_uploads", {
			upload_session_id: "sess_1",
			files: [
				{ file_id: "a", parts: [{ part_number: 1, e_tag: '"abc"' }] },
				{ file_id: "b", parts: [{ part_number: 1, e_tag: '"def"' }] },
			],
		});
		expect(res.isError).toBeFalsy();
		expect(api.calls.map((c) => c.url.pathname)).toEqual(["/v1/uploads/sessions/sess_1/complete", "/v1/uploads/sessions/sess_1/complete"]);
		expect(api.calls[0].body).toEqual({ file_id: "a", parts: [{ part_number: 1, e_tag: '"abc"' }] });
		expect(body.success).toBe(false);
		expect(body.completed_file_ids).toEqual(["a"]);
		expect(body.failed_file_ids).toEqual(["b"]);
		expect(body.files[1].error.code).toBe("OBJECT_SIZE_MISMATCH");
		expect(body.next_steps).toContain("1 file(s) did not complete");
	});

	it("is an error only when no file completed", async () => {
		const api = mockApi();
		api.reply(apiError(404, "FILE_NOT_FOUND", "This file_id was not registered."));
		const { res, body } = await call(api, "complete_file_uploads", { upload_session_id: "sess_1", files: [{ file_id: "x", parts: [{ part_number: 1, e_tag: '"a"' }] }] });
		expect(res.isError).toBe(true);
		expect(body.completed_file_ids).toEqual([]);
	});
});

const SUBMIT_ARGS = {
	upload_session_id: "sess_1",
	file_ids: ["a"],
	task_name: "September invoices",
	prompt: { fields: [{ name: "Invoice Number" }, { name: "Total Amount", prompt: "No currency symbol" }], general_prompt: "One row per invoice." },
	output_structure: "per_invoice",
};

describe("submit_extraction", () => {
	it("submits with typed values and questions on by default and a generated submission id", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202));
		const { body } = await call(api, "submit_extraction", SUBMIT_ARGS);
		expect(api.calls[0].method).toBe("POST");
		expect(api.calls[0].url.pathname).toBe("/v1/extractions");
		expect(api.calls[0].body).toEqual({
			submission_id: expect.stringMatching(/^sub_[0-9a-f]{16}$/),
			upload_session_id: "sess_1",
			file_ids: ["a"],
			task_name: "September invoices",
			prompt: SUBMIT_ARGS.prompt,
			output_structure: "per_invoice",
			options: { json_typed_values: true, ask_questions: true },
		});
		expect(body).toMatchObject({ success: true, extraction_id: "e1", submission_id: api.calls[0].body.submission_id });
		expect(body.next_steps).toContain("get_extraction");
	});

	it("respects the caller's options and submission id, and takes a plain-words prompt", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202));
		await call(api, "submit_extraction", {
			...SUBMIT_ARGS,
			submission_id: "sub_mine",
			prompt: "Extract invoice number and total",
			options: { ask_questions: false, json_typed_values: false, send_completion_email: true, exclude_columns: ["source_file"] },
		});
		expect(api.calls[0].body.submission_id).toBe("sub_mine");
		expect(api.calls[0].body.prompt).toBe("Extract invoice number and total");
		expect(api.calls[0].body.options).toEqual({ json_typed_values: false, ask_questions: false, send_completion_email: true, exclude_columns: ["source_file"] });
	});

	it("passes a refused submission through", async () => {
		const api = mockApi();
		api.reply(apiError(503, "SUBMISSIONS_PAUSED", "Extraction submissions are temporarily paused while we deploy an update.", { retryable: true }));
		const { res, body } = await call(api, "submit_extraction", SUBMIT_ARGS);
		expect(res.isError).toBe(true);
		expect(body.error.code).toBe("SUBMISSIONS_PAUSED");
	});
});

const COMPLETED = {
	success: true,
	status: "completed",
	extraction_id: "e1",
	credits_deducted: 1,
	credits_balance: 49,
	credits_reserved: 0,
	output_structure: "per_invoice",
	output_expires_at: "2026-12-12T00:00:00Z",
	pages: { successful_count: 1, failed_count: 0, successful: [{ file_name: "a.pdf", page: 1 }], failed: [], failure_reasons: [] },
	ai_uncertainty_notes: [],
	review_needed: { count: 0, items: [] },
	output: { xlsx_url: "https://storage.example.com/x.xlsx", csv_url: null, json_url: "https://storage.example.com/x.json" },
};

const RESULTS_PAGE = {
	success: true,
	extraction_id: "e1",
	status: "completed",
	output_structure: "per_invoice",
	output_expires_at: "2026-12-12T00:00:00Z",
	json_typed_values: true,
	columns: ["Invoice Number", "Total Amount", "Source File", "Review Needed"],
	rows: [{ "Invoice Number": "INV-1", "Total Amount": 12.5, "Source File": "a.pdf (Page 1)", "Review Needed": null }],
	offset: 0,
	limit: 100,
	row_count: 1,
	total_rows: 1,
	has_more: false,
	next_offset: null,
	review_needed: { count: 0, items: [] },
	pages: COMPLETED.pages,
};

describe("run_extraction", () => {
	it("submits, holds for the default wait and returns the completed status with the first page of rows", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202), ok(COMPLETED), ok(RESULTS_PAGE));
		const { res, body } = await call(api, "run_extraction", SUBMIT_ARGS);
		expect(res.isError).toBeFalsy();
		expect(api.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
			"POST /v1/extractions",
			"GET /v1/extractions/e1?wait=25",
			"GET /v1/extractions/e1/results?offset=0&limit=100",
		]);
		expect(body).toMatchObject({ ...withoutSuccessfulPages(COMPLETED), submission_id: api.calls[0].body.submission_id });
		expect(body.pages.successful).toBeUndefined();
		expect(body.results).toEqual({ ...withoutSuccessfulPages(RESULTS_PAGE), truncated: false });
		expect(body.next_steps).toContain("review_needed");
	});

	it("keeps the submitted extraction's handle when the status read fails, so the agent waits instead of submitting again", async () => {
		const api = mockApi();
		api.reply(
			ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202),
			apiError(502, "INTERNAL_ERROR", "Internal Server Error.", { retryable: true }),
		);
		const { res, body } = await call(api, "run_extraction", SUBMIT_ARGS);
		expect(res.isError).toBeFalsy();
		expect(api.calls).toHaveLength(2);
		expect(body).toMatchObject({ success: true, extraction_id: "e1", submission_id: api.calls[0].body.submission_id });
		expect(body.status_error.code).toBe("INTERNAL_ERROR");
		expect(body.next_steps).toContain("Do not submit again");
		expect(body.next_steps).toContain("get_extraction");
	});

	it("gives the attached rows what the cap leaves after a large completed status", async () => {
		const api = mockApi();
		const items = Array.from({ length: 400 }, (_, i) => ({ message: `Check the total on row ${i + 1}.`, affected_fields: ["Total Amount"], output_row_numbers: [i + 1], source_references: [`f${i + 1}.pdf (Page 1)`] }));
		const rows = Array.from({ length: 100 }, (_, i) => ({ "Invoice Number": `INV-${i + 1}`, "Total Amount": i, "Source File": `f${i + 1}.pdf (Page 1)`, "Review Needed": null }));
		api.reply(
			ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202),
			ok({ ...COMPLETED, review_needed: { count: 400, items } }),
			ok({ ...RESULTS_PAGE, rows, row_count: 100, total_rows: 400, has_more: true, next_offset: 100 }),
		);
		const { res, body } = await call(api, "run_extraction", SUBMIT_ARGS);
		expect(res.isError).toBeFalsy();
		// The rows are measured on their own; nested under `results` they gain two spaces a line.
		expect(res.content[0].text.length).toBeLessThanOrEqual(RESULT_CHAR_CAP + 2_000);
		expect(body.review_needed.count).toBe(400);
		expect(body.review_needed.items_omitted).toBeGreaterThan(0);
		expect(body.results.rows.length).toBeGreaterThan(0);
		expect(body.results.rows.length).toBeLessThan(100);
		expect(body.results.truncated).toBe(true);
		expect(body.results.next_offset).toBe(body.results.rows.length);
	});

	it("hands back the handle and the next step when the extraction is still running after the wait", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202), ok({ success: true, status: "processing", extraction_id: "e1", progress: 42 }));
		const { res, body } = await call(api, "run_extraction", { ...SUBMIT_ARGS, wait: 10 });
		expect(res.isError).toBeFalsy();
		expect(api.calls[1].url.search).toBe("?wait=10");
		expect(api.calls).toHaveLength(2);
		expect(body).toMatchObject({ status: "processing", extraction_id: "e1", progress: 42 });
		expect(body.next_steps).toContain("get_extraction");
		expect(body.next_steps).toContain("42%");
	});

	it("hands back the questions when the extraction stops to ask", async () => {
		const api = mockApi();
		const waiting = {
			success: true,
			status: "input_required",
			extraction_id: "e1",
			progress: 22,
			answer_by: "2026-09-15T09:00:00Z",
			questions: [{ question_id: "q_1", type: "free_text", question: "Which date format?", choices: [], recommended_approach: "YYYY-MM-DD" }],
		};
		api.reply(ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202), ok(waiting));
		const { res, body } = await call(api, "run_extraction", SUBMIT_ARGS);
		expect(res.isError).toBeFalsy();
		expect(body.questions).toEqual(waiting.questions);
		expect(body.next_steps).toContain("answer_extraction_questions");
	});

	it("reports a failed extraction as an error with the API's message", async () => {
		const api = mockApi();
		api.reply(
			ok({ success: true, extraction_id: "e1", submission_state: "received" }, 202),
			ok({ success: false, status: "failed", extraction_id: "e1", error: { code: "PROMPT_UNCLEAR", message: "The prompt could not be understood.", retryable: false, details: null } }),
		);
		const { res, body } = await call(api, "run_extraction", SUBMIT_ARGS);
		expect(res.isError).toBe(true);
		expect(body.error.code).toBe("PROMPT_UNCLEAR");
		expect(body.next_steps).toContain("error.message");
	});
});

describe("get_extraction", () => {
	it("holds for 25 seconds by default and passes the scope through", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, status: "processing", extraction_id: "e1", progress: 5 }));
		const { body } = await call(api, "get_extraction", { extraction_id: "e1", scope: "team" });
		expect(api.calls[0].url.pathname).toBe("/v1/extractions/e1");
		expect(Object.fromEntries(api.calls[0].url.searchParams)).toEqual({ wait: "25", scope: "team" });
		expect(body.next_steps).toContain("5%");
	});

	it("answers at once with wait 0 and reads the completed status without fetching rows", async () => {
		const api = mockApi();
		api.reply(ok(COMPLETED));
		const { body } = await call(api, "get_extraction", { extraction_id: "e1", wait: 0 });
		expect(api.calls[0].url.search).toBe("");
		expect(api.calls).toHaveLength(1);
		expect(body.results).toBeUndefined();
		expect(body.next_steps).toContain("get_extraction_results");
	});

	it("passes an unknown extraction through as an error", async () => {
		const api = mockApi();
		api.reply(apiError(404, "EXTRACTION_NOT_FOUND", "No extraction found for this extraction_id."));
		const { res, body } = await call(api, "get_extraction", { extraction_id: "nope" });
		expect(res.isError).toBe(true);
		expect(body.error.code).toBe("EXTRACTION_NOT_FOUND");
		expect(body.next_steps).toBeUndefined();
	});

	it("treats a status it does not know as still running", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, status: "reviewing", extraction_id: "e1" }));
		const { res, body } = await call(api, "get_extraction", { extraction_id: "e1" });
		expect(res.isError).toBeFalsy();
		expect(body.next_steps).toContain("still running");
	});
});

describe("answer_extraction_questions", () => {
	it("posts the answers and returns the status after them", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, status: "processing", extraction_id: "e1", progress: 22 }));
		const answers = [{ question_id: "q_1", choice_id: "a", text: "Except on credit notes." }, { question_id: "q_2", accept_recommended: true }];
		const { body } = await call(api, "answer_extraction_questions", { extraction_id: "e1", answers });
		expect(api.calls[0].method).toBe("POST");
		expect(api.calls[0].url.pathname).toBe("/v1/extractions/e1/answers");
		expect(api.calls[0].body).toEqual({ answers });
		expect(body).toMatchObject({ status: "processing", extraction_id: "e1" });
		expect(body.next_steps).toContain("get_extraction");
	});

	it("passes a refused request through with the issues", async () => {
		const api = mockApi();
		api.reply(apiError(400, "INVALID_INPUT", "Request validation failed.", { details: { issues: [{ message: "unknown question", path: ["answers", 0, "question_id"] }] } }));
		const { res, body } = await call(api, "answer_extraction_questions", { extraction_id: "e1", answers: [{ question_id: "q_x", text: "hi" }] });
		expect(res.isError).toBe(true);
		expect(body.error.details.issues).toHaveLength(1);
	});
});

describe("get_extraction_results", () => {
	it("reads a page with the caller's paging and marks it untruncated", async () => {
		const api = mockApi();
		api.reply(ok(RESULTS_PAGE));
		const { body } = await call(api, "get_extraction_results", { extraction_id: "e1", offset: 0, limit: 1000 });
		expect(api.calls[0].url.pathname).toBe("/v1/extractions/e1/results");
		expect(Object.fromEntries(api.calls[0].url.searchParams)).toEqual({ offset: "0", limit: "1000" });
		expect(body).toEqual({ ...withoutSuccessfulPages(RESULTS_PAGE), truncated: false });
	});

	it("cuts a page that would exceed the result cap and says where to continue", async () => {
		const api = mockApi();
		const rows = Array.from({ length: 1000 }, (_, i) => ({ "Invoice Number": `INV-${i + 1}`, "Total Amount": i, "Source File": `f${i}.pdf (Page 1)`, "Review Needed": null }));
		api.reply(ok({ ...RESULTS_PAGE, rows, row_count: 1000, total_rows: 1000, limit: 1000 }));
		const { res, body } = await call(api, "get_extraction_results", { extraction_id: "e1", limit: 1000 });
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text.length).toBeLessThanOrEqual(RESULT_CHAR_CAP);
		expect(body.truncated).toBe(true);
		expect(body.has_more).toBe(true);
		expect(body.next_offset).toBe(body.rows.length);
		expect(body.next_steps).toContain(`offset=${body.rows.length}`);
	});

	it("passes an unavailable output through", async () => {
		const api = mockApi();
		api.reply(apiError(404, "OUTPUT_NOT_AVAILABLE", "Output is not available for this extraction."));
		const { res, body } = await call(api, "get_extraction_results", { extraction_id: "e1" });
		expect(res.isError).toBe(true);
		expect(body.error.code).toBe("OUTPUT_NOT_AVAILABLE");
	});
});

describe("get_output_download_url, list_extractions, cancel_extraction", () => {
	it("asks for a download address in the format named", async () => {
		const api = mockApi();
		api.reply(ok({ download_url: "https://storage.example.com/x.xlsx?sig", format: "xlsx", expires_in_seconds: 300 }));
		const { res, body } = await call(api, "get_output_download_url", { extraction_id: "e1", format: "xlsx" });
		expect(res.isError).toBeFalsy();
		expect(api.calls[0].url.pathname).toBe("/v1/extractions/e1/output");
		expect(Object.fromEntries(api.calls[0].url.searchParams)).toEqual({ format: "xlsx" });
		expect(body).toMatchObject({ download_url: "https://storage.example.com/x.xlsx?sig", format: "xlsx", expires_in_seconds: 300 });
		expect(body.next_steps).toContain("no Authorization header");
	});

	it("lists with every filter as a query parameter", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, extractions: [], has_more: false, next_cursor: null }));
		await call(api, "list_extractions", { status: "input_required", submission_method: "api", created_after: "2026-09-01T00:00:00Z", limit: 50, cursor: "abc" });
		expect(api.calls[0].method).toBe("GET");
		expect(api.calls[0].url.pathname).toBe("/v1/extractions");
		expect(Object.fromEntries(api.calls[0].url.searchParams)).toEqual({
			status: "input_required",
			submission_method: "api",
			created_after: "2026-09-01T00:00:00Z",
			limit: "50",
			cursor: "abc",
		});
	});

	it("cancels with a POST and says to wait for the cancelled status", async () => {
		const api = mockApi();
		api.reply(ok({ success: true, extraction_id: "e1", status: "processing", cancellation_requested: true, cancel_requested_at: "2026-09-13T10:00:00Z" }));
		const { body } = await call(api, "cancel_extraction", { extraction_id: "e1" });
		expect(api.calls[0].method).toBe("POST");
		expect(api.calls[0].url.pathname).toBe("/v1/extractions/e1/cancel");
		expect(api.calls[0].body).toBeNull();
		expect(body.cancellation_requested).toBe(true);
		expect(body.next_steps).toContain("cancelled");
	});

	it("passes a not-cancellable refusal through", async () => {
		const api = mockApi();
		api.reply(apiError(409, "EXTRACTION_NOT_CANCELLABLE", "This extraction has already completed or failed.", { details: { status: "completed" } }));
		const { res, body } = await call(api, "cancel_extraction", { extraction_id: "e1" });
		expect(res.isError).toBe(true);
		expect(body.error.details.status).toBe("completed");
	});

	it("encodes identifiers into the path so they cannot escape it", async () => {
		const api = mockApi();
		api.reply(apiError(400, "INVALID_INPUT", "extraction_id is not a valid UUID."));
		await call(api, "cancel_extraction", { extraction_id: "../credits/balance" });
		expect(api.calls[0].url.pathname).toBe("/v1/extractions/..%2Fcredits%2Fbalance/cancel");
	});

	it("refuses '.' and '..' as identifiers, which a URL would fold into another operation, without calling the API", async () => {
		const api = mockApi();
		const client = await connect(api);
		try {
			for (const [name, args] of [
				["get_extraction", { extraction_id: ".", wait: 0 }],
				["get_extraction", { extraction_id: "..", wait: 0 }],
				["get_upload_part_urls", { upload_session_id: ".", file_id: "f1", part_numbers: [1] }],
				["complete_file_uploads", { upload_session_id: "..", files: [{ file_id: "f1", parts: [{ part_number: 1, e_tag: '"x"' }] }] }],
			]) {
				// A schema refusal is the SDK's plain-text result, not the API's envelope.
				const res = await client.callTool({ name, arguments: args });
				expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
			}
		} finally {
			await client.close();
		}
		expect(api.calls).toHaveLength(0);
	});
});
