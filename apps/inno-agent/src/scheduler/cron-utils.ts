import { logger } from "../logger.js";
import { CronExpressionParser } from "cron-parser";

/**
 * Default timezone for scheduled jobs when neither the job nor the global
 * `scheduler.timezone` config specifies one.
 */
export const DEFAULT_SCHEDULER_TIMEZONE = "Asia/Shanghai";

export function computeNextRunAt(
	cron: string,
	timezone: string,
	currentDate: Date = new Date(),
): string | undefined {
	try {
		const expr = CronExpressionParser.parse(cron, {
			currentDate,
			tz: timezone || DEFAULT_SCHEDULER_TIMEZONE,
		});
		return expr.next().toDate().toISOString();
	} catch (err) {
		logger.warn({ err, cron }, "failed to compute next run time");
		return undefined;
	}
}

export function isCronDue(
	cron: string,
	timezone: string,
	lastRunAt: string | undefined,
	now: Date = new Date(),
): boolean {
	try {
		const expr = CronExpressionParser.parse(cron, {
			currentDate: now,
			tz: timezone || DEFAULT_SCHEDULER_TIMEZONE,
		});
		const prev = expr.prev().toDate();

		if (!lastRunAt) {
			const diffMs = now.getTime() - prev.getTime();
			return diffMs >= 0 && diffMs < 120_000;
		}

		return prev.getTime() > new Date(lastRunAt).getTime();
	} catch (err) {
		logger.warn({ err, cron }, "failed to check if cron is due");
		return false;
	}
}

/**
 * Validate a cron expression. Returns { ok: true } if parseable,
 * otherwise { ok: false, error: string }.
 */
export function validateCron(cron: string, timezone = DEFAULT_SCHEDULER_TIMEZONE): { ok: true } | { ok: false; error: string } {
	const value = (cron ?? "").trim();
	if (!value) return { ok: false, error: "Cron expression is required" };
	const fields = value.split(/\s+/);
	if (fields.length !== 5) {
		return { ok: false, error: `Cron must have 5 fields (minute hour day month weekday), got ${fields.length}` };
	}
	try {
		CronExpressionParser.parse(value, { tz: timezone || DEFAULT_SCHEDULER_TIMEZONE });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Detect a cron that can only fire once (minute, hour, day-of-month, month
 * all pinned to a single literal value). After firing, such a job's next run
 * would be a year later, which is almost never what the user intended for
 * one-shot reminders like "tomorrow at 14:30".
 */
export function isOneShotCron(cron: string): boolean {
	const fields = (cron ?? "").trim().split(/\s+/);
	if (fields.length !== 5) return false;
	const [m, h, dom, mon] = fields;
	const literal = /^\d+$/;
	return literal.test(m) && literal.test(h) && literal.test(dom) && literal.test(mon);
}
