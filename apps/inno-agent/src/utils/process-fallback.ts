/**
 * Process-level last-resort handlers (`uncaughtException` / `unhandledRejection`).
 *
 * Without these, a single stray rejection or an exception thrown from inside a
 * catch block (e.g. the HTTP catch-all calling `json()` after SSE headers were
 * already sent) takes the whole process down with no log entry and no cleanup.
 * Node's own stance is that the process state is untrustworthy after an
 * uncaught exception, so these handlers log at fatal level and then shut down
 * gracefully rather than trying to soldier on.
 */

import { logger } from "../logger.js";

export interface ProcessFallbackOptions {
	/**
	 * Best-effort cleanup before exit (e.g. closing the HTTP server so
	 * in-flight SSE/terminal clients get a close frame instead of a hang).
	 * A thrown error here is ignored — the process exits regardless.
	 */
	onFatal?: () => void | Promise<void>;
	/** Max milliseconds to wait for `onFatal` before forcing exit. */
	exitTimeoutMs?: number;
}

let installed = false;
let shuttingDown = false;

export function installProcessFallbacks(options: ProcessFallbackOptions = {}): void {
	if (installed) return;
	installed = true;

	const fatal = (kind: string, err: unknown): void => {
		// A second fault while shutting down (e.g. cleanup throws, or another
		// rejection lands) must not recurse — exit immediately.
		if (shuttingDown) {
			process.exit(1);
		}
		shuttingDown = true;

		logger.fatal({ err }, `[inno] ${kind} — shutting down`);

		const forceExit = setTimeout(() => process.exit(1), options.exitTimeoutMs ?? 3_000);
		forceExit.unref();

		Promise.resolve()
			.then(() => options.onFatal?.())
			.catch(() => {
				// Cleanup is best-effort; never let it block or prevent the exit.
			})
			.finally(() => process.exit(1));
	};

	process.on("uncaughtException", (err) => fatal("uncaughtException", err));
	process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
}
