import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { ChannelRegistry } from "../../channels/channel.js";
import type { JobStore } from "../../scheduler/job-store.js";
import type { ScheduledJob } from "../../scheduler/types.js";
import { executeJob } from "../../scheduler/job-runner.js";
import { validateCron } from "../../scheduler/cron-utils.js";
import { json, matchRoute, readBody } from "../http-helpers.js";

export interface JobsRouteContext {
	jobStore: JobStore;
	channelRegistry: ChannelRegistry;
}

/**
 * /api/jobs* route domain. Returns true when the request was handled.
 * Extracted verbatim from server.ts during the P2 route split (blocks were
 * originally at two sites in the giant handler; relative order within the
 * domain is preserved) — behavior unchanged.
 */
export async function handleJobsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: JobsRouteContext,
): Promise<boolean> {
	const { jobStore, channelRegistry } = ctx;

	if (method === "GET" && url === "/api/jobs") {
		json(res, 200, jobStore.list());
		return true;
	}

	if (method === "GET" && url === "/api/jobs/status") {
		json(res, 200, jobStore.getStatus());
		return true;
	}

	if (method === "GET" && url === "/api/jobs/runs") {
		json(res, 200, jobStore.listRuns());
		return true;
	}

	if (method === "POST" && url === "/api/jobs") {
		const body = await readBody(req) as Record<string, unknown> & Parameters<JobStore["create"]>[0];
		if (typeof body.cron !== "string") {
			json(res, 400, { error: "cron is required" });
			return true;
		}
		const cronCheck = validateCron(body.cron, typeof body.timezone === "string" ? body.timezone : undefined);
		if (!cronCheck.ok) {
			json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
			return true;
		}
		if (body.channel && !channelRegistry.get(body.channel)) {
			json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
			return true;
		}
		const job = jobStore.create(body);
		json(res, 201, job);
		return true;
	}

	const runsMatch = matchRoute("GET", method, url, "/api/jobs/:id/runs");
	if (runsMatch) {
		json(res, 200, jobStore.listRuns(runsMatch.id));
		return true;
	}

	const runMatch = matchRoute("POST", method, url, "/api/jobs/:id/run");
	if (runMatch) {
		const job = jobStore.get(runMatch.id);
		if (!job) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		const result = await executeJob(job, jobStore, channelRegistry, "api");
		json(res, 200, result);
		return true;
	}

	const patchMatch = matchRoute("PATCH", method, url, "/api/jobs/:id");
	if (patchMatch) {
		const body = await readBody(req) as Partial<ScheduledJob>;
		if (typeof body.cron === "string") {
			const cronCheck = validateCron(body.cron, body.timezone);
			if (!cronCheck.ok) {
				json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
				return true;
			}
		}
		if (body.channel && !channelRegistry.get(body.channel)) {
			json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
			return true;
		}
		const updated = jobStore.update(patchMatch.id, body);
		if (!updated) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		json(res, 200, updated);
		return true;
	}

	const deleteMatch = matchRoute("DELETE", method, url, "/api/jobs/:id");
	if (deleteMatch) {
		const deleted = jobStore.delete(deleteMatch.id);
		if (!deleted) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		json(res, 204, null);
		return true;
	}

	return false;
}
