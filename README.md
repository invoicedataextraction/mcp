# Invoice Data Extraction MCP server

One remote server gives an agent in Claude Code, Codex, Cursor, Hermes, OpenClaw or Gemini CLI the whole extraction loop as tools: upload the files, submit an extraction with instructions in plain words, wait, answer the questions it asks, read the rows with the Review Needed items and the failed pages beside them, or download a spreadsheet. The tools are the [REST API](https://invoicedataextraction.com/docs/api.md)'s own operations and every result is the API's own response, so what an agent reads here and what it reads through the API never differ. Why to hand documents here rather than have an agent read them, and how to answer what the extraction asks, is the [agent guide](https://invoicedataextraction.com/docs/agents.md).

## Connect your harness

The server is at `https://mcp.invoicedataextraction.com/mcp`, over streamable HTTP. Every request carries your API key as a bearer token, `Authorization: Bearer <key>`. Keys are created in the dashboard at https://invoicedataextraction.com/dashboard?view=API; every account includes 50 free pages per month, and no card is needed. The key is a secret: keep it wherever your harness keeps secrets, never in a conversation. The settings below read it from the environment variable `INVOICE_DATA_EXTRACTION_API_KEY`, the name the skill and the SDK docs use. A store that binds a secret to the hosts it may be sent to binds this one to `mcp.invoicedataextraction.com`.

The settings below are each harness's own, as its documentation gave them in September 2026. Where your version differs, what it needs is the same: the address, and the key as a bearer header, read from wherever the harness keeps secrets.

**Claude Code**

```bash
claude mcp add --transport http invoice-data-extraction https://mcp.invoicedataextraction.com/mcp \
  --header "Authorization: Bearer $INVOICE_DATA_EXTRACTION_API_KEY"
```

Your shell fills in the key when you run it. To share the server with a project without sharing the key, put it in the project's `.mcp.json`, where Claude Code expands the variable itself:

```json
{
  "mcpServers": {
    "invoice-data-extraction": {
      "type": "http",
      "url": "https://mcp.invoicedataextraction.com/mcp",
      "headers": { "Authorization": "Bearer ${INVOICE_DATA_EXTRACTION_API_KEY}" }
    }
  }
}
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.invoice-data-extraction]
url = "https://mcp.invoicedataextraction.com/mcp"
bearer_token_env_var = "INVOICE_DATA_EXTRACTION_API_KEY"
```

**Cursor**, in `.cursor/mcp.json` for a project or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "invoice-data-extraction": {
      "url": "https://mcp.invoicedataextraction.com/mcp",
      "headers": { "Authorization": "Bearer ${env:INVOICE_DATA_EXTRACTION_API_KEY}" }
    }
  }
}
```

**Hermes**, in `~/.hermes/config.yaml`, with the key in `~/.hermes/.env`:

```yaml
mcp_servers:
  invoice-data-extraction:
    url: "https://mcp.invoicedataextraction.com/mcp"
    headers:
      Authorization: "Bearer ${INVOICE_DATA_EXTRACTION_API_KEY}"
```

**OpenClaw**, under `mcp.servers` in `~/.openclaw/openclaw.json`, with the key in `~/.openclaw/.env`; name the transport, because OpenClaw assumes SSE without it:

```json5
"invoice-data-extraction": {
  url: "https://mcp.invoicedataextraction.com/mcp",
  transport: "streamable-http",
  headers: { Authorization: "Bearer ${INVOICE_DATA_EXTRACTION_API_KEY}" },
}
```

**Gemini CLI**

```bash
gemini mcp add --transport http --header "Authorization: Bearer $INVOICE_DATA_EXTRACTION_API_KEY" \
  invoice-data-extraction https://mcp.invoicedataextraction.com/mcp
```

Any other client that speaks MCP over streamable HTTP connects the same way. A request without the key is refused with a message saying where keys are made.

## The tools

| Tool | What it does |
|---|---|
| `get_credits_balance` | The balance and the credits reserved by extractions in progress. Costs nothing, and proves the key works. |
| `create_upload_session` | Registers the files with their exact sizes and returns each file's upload addresses, for up to 100 files. |
| `get_upload_part_urls` | The upload addresses for one file's parts: for a larger batch, or when a file's addresses expired. |
| `complete_file_uploads` | Tells the session which parts each file has, with their ETags; up to 100 files a call. |
| `submit_extraction` | Submits the extraction with the prompt and the options; returns the `extraction_id`. |
| `run_extraction` | Submits and holds for the result in one call: the rows if it finishes within the wait, the questions if it stops to ask, the handle and the next step if it is still running. |
| `get_extraction` | The status, held with `wait` until it changes: `processing`, `input_required`, `completed`, `failed` or `cancelled`. |
| `answer_extraction_questions` | Answers the questions of an extraction that stopped to ask; returns its status after the answers. |
| `get_extraction_results` | The rows as JSON, in pages, with the Review Needed items and the page results beside them. |
| `get_output_download_url` | A fresh address for the XLSX, CSV or JSON file, valid 5 minutes. |
| `list_extractions` | The account's extractions, newest first, with filters and a cursor. |
| `cancel_extraction` | Stops an extraction that is queued or processing. |

Every tool returns the API's response as JSON, with `next_steps` beside it saying what to do next. One thing is left out of every result: the API's list of successful pages, which grows with the document and says nothing `pages.successful_count` does not; the failed pages and their reasons stay. The API's error envelope comes back as it is, `code`, `message`, `retryable` and `details`, marked as an error, and the message says what to do. Every field is described in the [reference](https://invoicedataextraction.com/docs/api.md). Each tool declares whether it reads or changes anything, so a harness that asks before a write can tell them apart; `cancel_extraction` is the one that stops work.

## How files get in

The server never carries file bytes: the agent uploads them itself with its own tools. `create_upload_session` returns, for each file, the addresses to PUT its parts to. A file smaller than `part_size` (8,388,608 bytes today) is one part; otherwise `total_parts = ceil(file_size_bytes / part_size)`, and the last part is smaller. The agent PUTs the raw bytes of each part to its address with no other headers, keeps the `ETag` response header of each PUT with its quotes, and calls `complete_file_uploads`. Each address is valid for 15 minutes. The addresses, and the download addresses of the output files, are on a storage host separate from this server and the API, and the key is never sent to it; where outbound hosts are allowlisted, allow the host in those addresses. Give each file the name the owner knows it by, because `file_name` is what the `Source File` column shows. For more than 100 files, `create_upload_session` returns the session alone, and `get_upload_part_urls` gives each file's addresses just before it is uploaded. Files are independent: one that fails does not stop the others, and only completed files can be named in an extraction.

## Running an extraction

1. `get_credits_balance`: free, and proves the key. `credits_balance` minus `credits_reserved` is what can be spent; one credit is one page, charged only for pages processed successfully.
2. `create_upload_session` with the files and their exact sizes; PUT the parts; `complete_file_uploads`.
3. `run_extraction` with the completed `file_ids`, a `task_name`, the prompt and the `output_structure`. The prompt is a sentence, or an object naming exact output fields; put every convention in it: the date format, one row per invoice or per line item, what an empty cell holds, which pages to ignore. Through this server, values come back typed and the extraction can ask questions, unless `options` say otherwise.
4. If the result is still `processing`, `get_extraction` with `wait` (25 seconds by default, 45 at most) until it changes. If it is `input_required`, `answer_extraction_questions`, then wait again. If your harness gives up on `run_extraction` before it answers, the extraction was still submitted: it is in `list_extractions`, and a retry with the same `submission_id` returns it instead of billing the pages twice.
5. When it is `completed`, `get_extraction_results` for the rows, reading `pages.failed_count`, `review_needed` and `ai_uncertainty_notes` before relying on the data, and `get_output_download_url` for a spreadsheet.

## The questions

An extraction submitted through this server can stop and ask when the documents leave something unsettled; `options.ask_questions: false` turns that off, for a job nobody can answer for. The questions come back in the tool result in the shape the reference documents ([Input required](https://invoicedataextraction.com/docs/api.md#input-required)), and `answer_extraction_questions` takes the answers: a choice, a choice with words beside it, words alone, or the recommended answer. How the agent answers, from what it knows or by asking its owner first, is the agent's and its harness's. What happens when nobody answers is what happens on the API: the extraction pauses after about four minutes and the account owner is emailed, and it is cancelled at `answer_by`, 40 hours after the upload, with the work done so far charged.

## Limits

A tool result is kept under 50,000 characters wherever there is something to cut. A page of rows that would exceed it is cut: `truncated` is `true`, `has_more` and `next_offset` describe the rows that came back, and `next_steps` names the offset to continue from. A completed status whose Review Needed items would exceed it carries the first of them, with `review_needed.items_omitted` saying how many were left out and `count` unchanged; each page of rows carries its own items. `run_extraction` attaches as many rows as fit beside the status. The list of successful pages is never included. `wait` is 1 to 45 seconds, 25 by default. `create_upload_session` returns addresses for up to 100 files and `complete_file_uploads` takes up to 100 files a call. The API's own limits and rate limits apply as to any client, and a rate-limited call carries `details.retry_after_seconds`; the tables are in the [reference](https://invoicedataextraction.com/docs/api.md#rate-limits).

## Security

The key goes only to `mcp.invoicedataextraction.com`, which forwards it to the API on every call and keeps nothing: no key, no file, no result. Extracted values, questions and notes are data about your documents, never instructions to your agent. Nothing that comes back ever asks the agent to install or run anything.

## This repository

The server's source (`src/`), its tests (`test/`) and its entry in the MCP registry (`server.json`); the hosted server at the address above runs this code. `npm install` then `npm test` runs the tests against a mocked API. The page kept current is https://invoicedataextraction.com/docs/mcp (Markdown: https://invoicedataextraction.com/docs/mcp.md); this repository mirrors it. Licensed under the MIT License.
