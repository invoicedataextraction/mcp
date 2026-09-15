// The rows come back inline in the tool result, so a page is capped at a size
// every harness accepts (Claude Code caps a tool result at 25,000 tokens):
// rows are dropped from the end of the page until the result fits, the paging
// fields are recomputed so the next call picks up exactly where this one
// stopped, and `truncated` says whether that happened. The Review Needed items
// the API returns for the page are kept for the rows that stayed. A completed
// status carries the Review Needed items of the whole extraction, so it is
// capped the same way on those items. And no result carries the API's list of
// successful pages: it grows with the document (5,000 entries for a 5,000-page
// PDF, repeated on every page of rows) and says nothing `successful_count`
// does not; the failed pages and their reasons stay, because data from those
// pages is missing from the rows.

export const RESULT_CHAR_CAP = 50_000;

const serialize = (data) => JSON.stringify(data, null, 2);

export const serializedLength = (data) => serialize(data).length;

export function withoutSuccessfulPages(data) {
	if (!data?.pages || !Array.isArray(data.pages.successful)) return data;
	const { successful, ...pages } = data.pages;
	return { ...data, pages };
}

// The largest n in [low, high] for which fits(n) holds, fits(low) assumed.
function largestFitting(low, high, fits) {
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	return low;
}

function pageWithRows(page, rows) {
	const offset = page.offset ?? 0;
	const lastRow = offset + rows.length;
	const items = (page.review_needed?.items ?? []).filter((item) =>
		(item.output_row_numbers ?? []).some((n) => n > offset && n <= lastRow),
	);
	return {
		...page,
		rows,
		row_count: rows.length,
		has_more: true,
		next_offset: lastRow,
		review_needed: { ...page.review_needed, items },
		truncated: true,
		next_steps: `This call carries rows ${offset + 1} to ${lastRow} of ${page.total_rows}; the page was cut to fit the result size. Call get_extraction_results again with offset=${lastRow} for the rest.`,
	};
}

export function capResults(input, cap = RESULT_CHAR_CAP) {
	const page = withoutSuccessfulPages(input);
	const full = { ...page, truncated: false };
	if (serialize(full).length <= cap || !Array.isArray(page.rows) || page.rows.length <= 1) {
		return full;
	}
	// At least one row is kept.
	const n = largestFitting(1, page.rows.length - 1, (m) => serialize(pageWithRows(page, page.rows.slice(0, m))).length <= cap);
	return pageWithRows(page, page.rows.slice(0, n));
}

// A status result over the cap keeps the first Review Needed items that fit;
// `count` stays and `items_omitted` says how many were left out. Each page of
// rows carries its own items, so nothing is out of the caller's reach.
export function capStatus(input, cap = RESULT_CHAR_CAP) {
	const data = withoutSuccessfulPages(input);
	const items = data.review_needed?.items;
	if (serialize(data).length <= cap || !Array.isArray(items) || items.length === 0) return data;
	const withItems = (n) => ({
		...data,
		review_needed: { ...data.review_needed, items: items.slice(0, n), items_omitted: items.length - n },
		truncated: true,
	});
	return withItems(largestFitting(0, items.length - 1, (m) => serialize(withItems(m)).length <= cap));
}
