import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";

/**
 * Shared HTTP helpers for the server route domains.
 * Extracted verbatim from server.ts during the P2 route split — behavior
 * unchanged. Route modules under server/routes/ import from here instead of
 * re-defining their own copies.
 */

export function readBody(req: HttpReq): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: Buffer) => {
			data += chunk.toString();
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (err) {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

export function json(res: ServerResponse, status: number, data: unknown): void {
	const body = data !== null ? JSON.stringify(data) : "";
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

/**
 * Simple route matching with :param support.
 * Returns params object or null if no match.
 */
export function matchRoute(
	method: string,
	reqMethod: string,
	reqUrl: string,
	pattern: string,
): Record<string, string> | null {
	if (reqMethod !== method) return null;
	const url = reqUrl.split("?")[0];
	const patternParts = pattern.split("/");
	const urlParts = url.split("/");
	if (patternParts.length !== urlParts.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i++) {
		if (patternParts[i].startsWith(":")) {
			try {
				params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
			} catch (err) {
				params[patternParts[i].slice(1)] = urlParts[i];
			}
		} else if (patternParts[i] !== urlParts[i]) {
			return null;
		}
	}
	return params;
}
