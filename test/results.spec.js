import { describe, it, expect } from "vitest";
import { capResults, capStatus, withoutSuccessfulPages, RESULT_CHAR_CAP } from "../src/results.js";

const page = (rows, { offset = 0, total = rows.length, items = [] } = {}) => ({
	success: true,
	extraction_id: "e1",
	status: "completed",
	columns: ["Invoice Number", "Total Amount", "Source File", "Review Needed"],
	rows,
	offset,
	limit: 1000,
	row_count: rows.length,
	total_rows: total,
	has_more: offset + rows.length < total,
	next_offset: offset + rows.length < total ? offset + rows.length : null,
	review_needed: { count: items.length, items },
	pages: { successful_count: 1, failed_count: 0, successful: [], failed: [], failure_reasons: [] },
});

const row = (i) => ({
	"Invoice Number": `INV-${i}`,
	"Total Amount": i * 10,
	"Source File": `invoice-${i}.pdf (Page 1)`,
	"Review Needed": null,
});

describe("capResults", () => {
	it("passes a small page through with truncated false and nothing else changed", () => {
		const small = page([row(1), row(2)]);
		const out = capResults(small);
		expect(out).toEqual({ ...withoutSuccessfulPages(small), truncated: false });
		expect(out.pages).toEqual({ successful_count: 1, failed_count: 0, failed: [], failure_reasons: [] });
	});

	it("cuts a large page to the cap, recomputes the paging and keeps the Review Needed items of the rows that stayed", () => {
		const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
		const items = [
			{ message: "check row 3", affected_fields: ["Total Amount"], output_row_numbers: [3], source_references: [] },
			{ message: "check row 900", affected_fields: [], output_row_numbers: [900], source_references: [] },
		];
		const out = capResults(page(rows, { total: 5000, items }));
		expect(out.truncated).toBe(true);
		expect(JSON.stringify(out, null, 2).length).toBeLessThanOrEqual(RESULT_CHAR_CAP);
		expect(out.rows.length).toBeGreaterThan(100);
		expect(out.rows.length).toBeLessThan(1000);
		expect(out.rows[0]).toEqual(row(1));
		expect(out.row_count).toBe(out.rows.length);
		expect(out.has_more).toBe(true);
		expect(out.next_offset).toBe(out.rows.length);
		expect(out.total_rows).toBe(5000);
		expect(out.review_needed.count).toBe(2);
		expect(out.review_needed.items).toEqual([items[0]]);
		expect(out.next_steps).toContain(`offset=${out.rows.length}`);
		// One more row would not have fitted.
		const oneMore = { ...out, rows: rows.slice(0, out.rows.length + 1) };
		expect(JSON.stringify(oneMore, null, 2).length).toBeGreaterThan(RESULT_CHAR_CAP);
	});

	it("continues the numbering from the page's offset", () => {
		const rows = Array.from({ length: 1000 }, (_, i) => row(i + 2001));
		const items = [{ message: "m", affected_fields: [], output_row_numbers: [2001], source_references: [] }];
		const out = capResults(page(rows, { offset: 2000, total: 3000, items }));
		expect(out.truncated).toBe(true);
		expect(out.next_offset).toBe(2000 + out.rows.length);
		expect(out.review_needed.items).toEqual(items);
	});

	it("leaves the list of successful pages out, so a long document's page list never crowds out the rows", () => {
		const successful = Array.from({ length: 5000 }, (_, i) => ({ file_name: "invoice.pdf", page: i + 1 }));
		const failed = [{ file_name: "invoice.pdf", page: 4999 }];
		const long = { ...page([row(1)]), pages: { successful_count: 4999, failed_count: 1, successful, failed, failure_reasons: [] } };
		expect(JSON.stringify(long, null, 2).length).toBeGreaterThan(RESULT_CHAR_CAP);
		const out = capResults(long);
		expect(JSON.stringify(out, null, 2).length).toBeLessThanOrEqual(RESULT_CHAR_CAP);
		expect(out.truncated).toBe(false);
		expect(out.rows).toEqual([row(1)]);
		expect(out.pages).toEqual({ successful_count: 4999, failed_count: 1, failed, failure_reasons: [] });
	});

	it("keeps at least one row even when a single row is over the cap", () => {
		const huge = { ...row(1), Notes: "x".repeat(RESULT_CHAR_CAP) };
		const out = capResults(page([huge, row(2)]));
		expect(out.rows).toHaveLength(1);
		expect(out.truncated).toBe(true);
		expect(out.next_offset).toBe(1);
	});
});

describe("capStatus", () => {
	const item = (n) => ({ message: `Check the total on row ${n}.`, affected_fields: ["Total Amount"], output_row_numbers: [n], source_references: [`invoice-${n}.pdf (Page 1)`] });
	const status = (items) => ({
		success: true,
		status: "completed",
		extraction_id: "e1",
		credits_deducted: 3000,
		pages: { successful_count: 3000, failed_count: 0, successful: Array.from({ length: 3000 }, (_, i) => ({ file_name: `invoice-${i + 1}.pdf`, page: 1 })), failed: [], failure_reasons: [] },
		ai_uncertainty_notes: [],
		review_needed: { count: items.length, items },
		output: { xlsx_url: "https://storage.example.com/x.xlsx", csv_url: null, json_url: null },
	});

	it("drops the successful pages and passes a status that then fits through unchanged", () => {
		const out = capStatus(status([item(1)]));
		expect(out.pages).toEqual({ successful_count: 3000, failed_count: 0, failed: [], failure_reasons: [] });
		expect(out.review_needed).toEqual({ count: 1, items: [item(1)] });
		expect(out.truncated).toBeUndefined();
	});

	it("cuts the Review Needed items of a status over the cap, keeps the count and says how many were left out", () => {
		const items = Array.from({ length: 3000 }, (_, i) => item(i + 1));
		const out = capStatus(status(items));
		expect(JSON.stringify(out, null, 2).length).toBeLessThanOrEqual(RESULT_CHAR_CAP);
		expect(out.truncated).toBe(true);
		expect(out.review_needed.count).toBe(3000);
		expect(out.review_needed.items.length).toBeGreaterThan(50);
		expect(out.review_needed.items[0]).toEqual(item(1));
		expect(out.review_needed.items_omitted).toBe(3000 - out.review_needed.items.length);
		const oneMore = { ...out, review_needed: { ...out.review_needed, items: items.slice(0, out.review_needed.items.length + 1) } };
		expect(JSON.stringify(oneMore, null, 2).length).toBeGreaterThan(RESULT_CHAR_CAP);
	});
});
