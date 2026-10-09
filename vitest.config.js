import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// The tests pass their own `env` to the worker with a mocked API binding
// (test/mockApi.js); the binding declared here only satisfies the config so
// the runtime starts.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// The secret the website and the worker share for the sign-in's handoff.
				bindings: { CONNECT_SECRET: "test-connect-secret" },
				serviceBindings: {
					API: () => new Response("the tests mock the API binding", { status: 500 }),
				},
			},
		}),
	],
});
