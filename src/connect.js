// Connecting from an assistant: the sign-in that lets ChatGPT, Claude and any
// other MCP client connect with the owner's account instead of a pasted API
// key. The OAuth provider (src/index.js) runs the protocol; these three
// endpoints are the part that is ours, and every page a person sees is on the
// website, not here.
//
// /authorize sends the owner to the website's connect page, carrying the facts
// a consent page must show (the client's name, its verified domain when it has
// one, where access will be sent), with the client's request kept here, bound
// to the browser, for an hour. There they sign in or create an account and
// approve the client, and the website creates an ordinary API key for them,
// exactly as the dashboard does, and hands it to /connect/handoff server to
// server, authenticated by a secret the two share. /connect/callback then
// finishes the authorization with that key as the grant's props, which the
// provider stores encrypted; from there every tool call is an API-key call like
// any other, billed and validated by the API as today.
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";

export const AUTHORIZE_PATH = "/authorize";
export const HANDOFF_PATH = "/connect/handoff";
export const CALLBACK_PATH = "/connect/callback";

const HANDOFF_PREFIX = "connect-handoff:";
// Long enough for the website's redirect to arrive; the storage's floor is 60 seconds.
const HANDOFF_TTL_SECONDS = 120;
// A connection attempt, from /authorize to the callback, is bound to the
// browser that started it and kept this long: the person may be creating an
// account on the website in between, with an email code and a pause, so the
// attempt is carried here, the provider's way, with a lifetime of its own.
const ATTEMPT_TTL_SECONDS = 60 * 60;
const ATTEMPT_PREFIX = "connect-attempt:";
const ATTEMPT_COOKIE = "__Host-ide-connect";
// A handoff whose browser never finishes the connection leaves the person with
// a key and no connection, and no page of ours shows them failing. Each handoff
// leaves a marker the callback clears; the scheduled sweep reports as an error
// every marker older than this, once.
const UNRETURNED_PREFIX = "connect-unreturned:";
const UNRETURNED_AFTER_MS = 10 * 60 * 1000;
const UNRETURNED_TTL_SECONDS = 24 * 60 * 60;
const API_KEY_PATTERN = /^ide_[0-9a-f]{64}$/;

const encoder = new TextEncoder();

const json = (status, body) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const redirect = (location, headers = new Headers()) => {
	headers.set("Location", location);
	return new Response(null, { status: 302, headers });
};

// The website's connect page renders every failure a person can meet here, so
// the browser is sent there with the reason rather than shown a bare page.
const toConnectPage = (env, error, headers) => {
	const target = new URL("/connect", env.SITE_ORIGIN);
	target.searchParams.set("error", error);
	return redirect(target.toString(), headers);
};

const sha256 = async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function secretMatches(header, secret) {
	const presented = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
	if (!presented || !secret) return false;
	// Equal-length digests, so the comparison takes the same time whatever was sent.
	return crypto.subtle.timingSafeEqual(await sha256(presented), await sha256(secret));
}

// What waits in storage for the browser, the handed-off key and the attempt's
// authorization request, is kept under the hash of a one-time secret the
// browser carries and encrypted with a key only that secret derives, so
// reading the storage alone reveals neither the secret nor the record. Taking
// a record deletes it: each is used once.
async function sealKey(secret) {
	return crypto.subtle.importKey("raw", await sha256(`seal:${secret}`), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function storeSealed(env, prefix, secret, record, ttlSeconds) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), encoder.encode(JSON.stringify(record))),
	);
	await env.OAUTH_KV.put(prefix + hex(await sha256(`id:${secret}`)), `${base64(iv)}.${base64(sealed)}`, {
		expirationTtl: ttlSeconds,
	});
}

async function takeSealed(env, prefix, secret) {
	const id = prefix + hex(await sha256(`id:${secret}`));
	const stored = await env.OAUTH_KV.get(id);
	if (!stored) return null;
	await env.OAUTH_KV.delete(id);
	const [iv, sealed] = stored.split(".").map(fromBase64);
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await sealKey(secret), sealed);
	return JSON.parse(new TextDecoder().decode(plain));
}

const storeHandoff = (env, code, record) => storeSealed(env, HANDOFF_PREFIX, code, record, HANDOFF_TTL_SECONDS);
const takeHandoff = (env, code) => takeSealed(env, HANDOFF_PREFIX, code);

// The attempt's binding: the state the website carries is the secret, and a
// cookie on this host, named after the state's hash and holding it, ties the
// attempt to the browser that started it, as the provider's own binding does
// (one cookie per attempt, so two tabs do not replace each other's).
const attemptCookieName = (hash) => `${ATTEMPT_COOKIE}_${hash.slice(0, 16)}`;
const attemptCookie = (hash, maxAge) =>
	`${attemptCookieName(hash)}=${maxAge > 0 ? hash : ""}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;

function readCookie(request, name) {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

async function beginAttempt(env, oauthRequest) {
	const state = hex(crypto.getRandomValues(new Uint8Array(32)));
	const hash = hex(await sha256(state));
	await storeSealed(env, ATTEMPT_PREFIX, state, { request: oauthRequest }, ATTEMPT_TTL_SECONDS);
	const headers = new Headers({ "Cache-Control": "no-store" });
	headers.append("Set-Cookie", attemptCookie(hash, ATTEMPT_TTL_SECONDS));
	return { state, headers };
}

async function finishAttempt(env, request) {
	const state = new URL(request.url).searchParams.get("state");
	if (!state) throw new AuthorizationError("invalid_request", { description: "Missing state parameter" });
	const hash = hex(await sha256(state));
	const bound = readCookie(request, attemptCookieName(hash));
	if (!bound) throw new AuthorizationError("invalid_request", { description: "This connection was not started in this browser; start again" });
	// Equal-length digests, so the comparison takes the same time whatever was sent.
	if (!crypto.subtle.timingSafeEqual(await sha256(hash), await sha256(bound))) {
		throw new AuthorizationError("invalid_request", { description: "This connection belongs to a different browser session; start again" });
	}
	const record = await takeSealed(env, ATTEMPT_PREFIX, state);
	if (!record?.request) throw new AuthorizationError("invalid_request", { description: "This connection expired or was already used; start again" });
	const headers = new Headers({ "Cache-Control": "no-store" });
	headers.append("Set-Cookie", attemptCookie(hash, 0));
	return { request: record.request, headers };
}

// GET /authorize: validate the client's request, keep it bound to this browser,
// and send the owner to the website's connect page.
export async function authorize(request, env) {
	const oauth = env.OAUTH_PROVIDER;
	let oauthRequest;
	let details;
	try {
		oauthRequest = await oauth.parseAuthRequest(request);
		details = await oauth.describeConsent(oauthRequest);
	} catch (error) {
		// Safe to send back to the client only once its redirect address is validated.
		if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
		if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
			console.warn(`Authorization request refused: ${error.name}: ${error.message}`);
			return toConnectPage(env, "invalid_request");
		}
		throw error;
	}

	const { state, headers } = await beginAttempt(env, oauthRequest);
	const target = new URL("/connect", env.SITE_ORIGIN);
	target.searchParams.set("state", state);
	target.searchParams.set("client", details.clientName.slice(0, 100));
	if (details.clientDomain) target.searchParams.set("domain", details.clientDomain);
	target.searchParams.set("to", details.redirectHost.slice(0, 200));
	if (details.redirectIsLoopback) target.searchParams.set("local", "1");
	// The website's first-touch attribution reads these, so an account created
	// here is counted as coming through an assistant's connection.
	target.searchParams.set("utm_source", "assistant_connect");
	target.searchParams.set("utm_campaign", (details.clientDomain ?? details.redirectHost).slice(0, 100));
	return redirect(target.toString(), headers);
}

// POST /connect/handoff, from the website's server only: the key it created
// for the owner who approved, exchanged for a one-time code the browser carries
// back to the callback.
export async function handoff(request, env) {
	if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
	if (!(await secretMatches(request.headers.get("authorization"), env.CONNECT_SECRET))) {
		console.error("Connect handoff refused: the shared secret did not match.");
		return json(401, { error: "unauthorized" });
	}
	const body = await request.json().catch(() => null);
	if (typeof body?.api_key !== "string" || !API_KEY_PATTERN.test(body.api_key) || typeof body?.user_id !== "string" || !body.user_id) {
		console.error("Connect handoff refused: malformed body.");
		return json(400, { error: "invalid_request" });
	}
	const code = hex(crypto.getRandomValues(new Uint8Array(32)));
	await storeHandoff(env, code, { apiKey: body.api_key, userId: body.user_id });
	// The marker only observes, so failing to write it never fails the handoff.
	try {
		await env.OAUTH_KV.put(await unreturnedMarker(code), "", {
			expirationTtl: UNRETURNED_TTL_SECONDS,
			metadata: { at: Date.now(), userId: body.user_id },
		});
	} catch (error) {
		console.error(`Connect marker not written for ${body.user_id}: ${error?.message}`);
	}
	return json(200, { code });
}

const unreturnedMarker = async (code) => UNRETURNED_PREFIX + hex(await sha256(`id:${code}`));

// Scheduled: every handoff whose browser has not finished the connection
// within UNRETURNED_AFTER_MS is logged as an error and forgotten. Returns the
// owners reported.
export async function reportUnreturned(env, now = Date.now()) {
	const reported = [];
	let cursor;
	do {
		const page = await env.OAUTH_KV.list({ prefix: UNRETURNED_PREFIX, cursor });
		for (const { name, metadata } of page.keys) {
			const minutes = Math.floor((now - metadata.at) / 60_000);
			if (now - metadata.at < UNRETURNED_AFTER_MS) continue;
			console.error(
				`Connect never completed: a key was handed off for ${metadata.userId} ${minutes} minutes ago and the browser did not finish the connection (it never came back, came back too late to finish, or came back after the attempt lapsed); the unused key is on the owner's API page.`,
			);
			await env.OAUTH_KV.delete(name);
			reported.push(metadata.userId);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return reported;
}

// GET /connect/callback: the browser back from the website, approved (a code)
// or declined (error=access_denied); either way the client gets its answer.
export async function callback(request, env) {
	const oauth = env.OAUTH_PROVIDER;
	let resumed;
	try {
		resumed = await finishAttempt(env, request);
	} catch (error) {
		// Expired, already used, or opened in another browser than the one that started.
		if (error instanceof AuthorizationError) {
			console.warn(`Connect callback refused: ${error.name}: ${error.message}`);
			return toConnectPage(env, "expired");
		}
		throw error;
	}
	const { request: original, headers } = resumed;
	const params = new URL(request.url).searchParams;

	if (params.get("error")) return redirect(authorizationErrorRedirect(original, "access_denied"), headers);

	const code = params.get("code");
	const record = code ? await takeHandoff(env, code) : null;
	if (!record) {
		// The website created a key and handed it off, but the code did not
		// arrive in time or at all: the key is left unused in the owner's
		// dashboard, and they connect again.
		console.error("Connect callback without a usable handoff code.");
		return toConnectPage(env, "expired", headers);
	}

	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: record.userId,
		metadata: {},
		scope: original.scope,
		props: { apiKey: record.apiKey, signedIn: true },
	});
	try {
		await env.OAUTH_KV.delete(await unreturnedMarker(code));
	} catch (error) {
		console.error(`Connect marker not cleared for ${record.userId}: ${error?.message}`);
	}
	return redirect(redirectTo, headers);
}
