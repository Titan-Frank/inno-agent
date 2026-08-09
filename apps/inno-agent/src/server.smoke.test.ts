import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * HTTP smoke tests for server.ts — the safety net for the route-domain
 * extraction in docs/quality-remediation-plan.md (P2).
 *
 * server.ts is a side-effect-only entry point (no exports), so these tests
 * spawn it as a child process against a throwaway --home with a dummy
 * provider, then assert status codes / redaction on a handful of endpoints.
 * No LLM calls are made.
 */

const SERVER_ENTRY = resolve(import.meta.dirname, "server.ts");
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const DUMMY_API_KEY = "sk-test-secret-key-12345";

let home: string;
let workspace: string;
let port: number;
let child: ChildProcess;
let childLog = "";

async function getFreePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const freePort = (srv.address() as AddressInfo).port;
			srv.close(() => resolvePort(freePort));
		});
		srv.on("error", reject);
	});
}

function api(path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "inno-smoke-home-"));
	workspace = mkdtempSync(join(tmpdir(), "inno-smoke-ws-"));
	mkdirSync(join(home, "config"), { recursive: true });
	writeFileSync(
		join(home, "config", "config.json"),
		JSON.stringify({
			defaultProvider: "dummy",
			defaultModel: "dummy-model",
			providers: {
				dummy: {
					baseUrl: "http://127.0.0.1:9", // nothing listens here; no LLM call is made
					apiKey: DUMMY_API_KEY,
					api: "openai-completions",
					models: [{ id: "dummy-model" }],
				},
			},
		}),
		"utf-8",
	);

	port = await getFreePort();
	child = spawn(
		process.execPath,
		["--import", "tsx", SERVER_ENTRY, "--home", home, "--workspace", workspace, "--port", String(port)],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.on("data", (chunk) => (childLog += chunk));
	child.stderr?.on("data", (chunk) => (childLog += chunk));

	// Wait for readiness: poll /health (it answers before any bootstrap).
	const deadline = Date.now() + 90_000;
	let ready = false;
	let exitCode: number | null = null;
	child.on("exit", (code) => {
		exitCode = code;
	});
	while (Date.now() < deadline) {
		if (exitCode !== null) {
			throw new Error(`server exited early with code ${exitCode}\n--- child log ---\n${childLog}`);
		}
		try {
			const res = await api("/health");
			if (res.status === 200) {
				ready = true;
				break;
			}
		} catch {
			// connection refused while the server is still starting
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!ready) {
		throw new Error(`server did not become ready within 90s\n--- child log ---\n${childLog}`);
	}
}, 120_000);

afterAll(async () => {
	if (child && !child.killed) {
		child.kill("SIGTERM");
		await new Promise<void>((resolveDone) => {
			const force = setTimeout(() => {
				child.kill("SIGKILL");
				resolveDone();
			}, 5_000);
			child.on("exit", () => {
				clearTimeout(force);
				resolveDone();
			});
		});
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
}, 30_000);

describe("server smoke", () => {
	it("GET /health returns 200 ok without bootstrap side effects", async () => {
		const res = await api("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("GET /api/settings returns 200 with provider API keys redacted", async () => {
		const res = await api("/api/settings");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providers: Record<string, { apiKey: string }>;
		};
		const apiKey = body.providers.dummy.apiKey;
		expect(apiKey).not.toBe(DUMMY_API_KEY);
		expect(apiKey).toMatch(/^\*\*\*\*/);
		expect(apiKey.endsWith(DUMMY_API_KEY.slice(-4))).toBe(true);
	}, 60_000 /* first /api/* call triggers lazy bootstrap */);

	it("GET /api/sessions returns 200", async () => {
		const res = await api("/api/sessions");
		expect(res.status).toBe(200);
	}, 60_000);

	it("GET /api/sessions/:id returns 404 for a missing session", async () => {
		const res = await api("/api/sessions/no-such-session.jsonl");
		expect(res.status).toBe(404);
	});

	it("POST /api/sessions/:id/archive + unarchive round-trips", async () => {
		const archive = await fetch(`http://127.0.0.1:${port}/api/sessions/some-session.jsonl/archive`, { method: "POST" });
		expect(archive.status).toBe(200);
		expect((await archive.json()) as { archived: boolean }).toEqual({ id: "some-session.jsonl", archived: true });
		const unarchive = await fetch(`http://127.0.0.1:${port}/api/sessions/some-session.jsonl/unarchive`, { method: "POST" });
		expect(unarchive.status).toBe(200);
		expect((await unarchive.json()) as { archived: boolean }).toEqual({ id: "some-session.jsonl", archived: false });
	});

	it("GET /api/jobs returns 200", async () => {
		const res = await api("/api/jobs");
		expect(res.status).toBe(200);
	});

	it("POST /api/jobs with an invalid cron returns 400 (route-domain extraction guard)", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "bad", cron: "not a cron", prompt: "x", taskType: "custom_prompt" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Invalid cron");
	});

	it("PUT /api/settings/theme accepts a valid theme and rejects an invalid one", async () => {
		const ok = await fetch(`http://127.0.0.1:${port}/api/settings/theme`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: "ocean" }),
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { ui: { theme: string } };
		expect(body.ui.theme).toBe("ocean");

		const bad = await fetch(`http://127.0.0.1:${port}/api/settings/theme`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: "neon" }),
		});
		expect(bad.status).toBe(400);
	});

	it("PUT /api/settings/memory validates boolean fields", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/settings/memory`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ l2Enabled: "yes" }),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/mcp returns 200 with the adapter overview", async () => {
		const res = await api("/api/mcp");
		expect(res.status).toBe(200);
	});

	it("GET /api/channels returns 200 with an empty list (no channels configured)", async () => {
		const res = await api("/api/channels");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("POST /api/bridge/messages returns 404 when no bridge is configured", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/bridge/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/skills returns 200 with a list", async () => {
		const res = await api("/api/skills");
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it("POST /api/skills/upload validates required fields", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/skills/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName: "x.zip" }),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/skills/:name/content returns 404 for a missing skill", async () => {
		const res = await api("/api/skills/no-such-skill/content");
		expect(res.status).toBe(404);
	});

	it("GET /api/jobs/:id/runs returns 200 for any id shape", async () => {
		const res = await api("/api/jobs/job_missing/runs");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("GET /api/workspaces returns 200 with the default workspaces", async () => {
		const res = await api("/api/workspaces");
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it("GET /api/workspace/tree returns 200 for the shared tmp workspace", async () => {
		const res = await api("/api/workspace/tree");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { type: string; children: unknown[] };
		expect(body.type).toBe("directory");
		expect(Array.isArray(body.children)).toBe(true);
	});

	it("GET /api/workspace/file returns 404 for a missing file", async () => {
		const res = await api("/api/workspace/file?path=no-such-file.txt");
		expect(res.status).toBe(404);
	});

	it("DELETE /api/workspaces/tmp is rejected with 400", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/tmp`, { method: "DELETE" });
		expect(res.status).toBe(400);
	});

	it("unknown /api/ route returns a JSON 404 (not the SPA index.html)", async () => {
		const res = await api("/api/definitely-not-a-route");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});
