/**
 * Symlink-aware path containment checks, shared by the HTTP file endpoints
 * (server/file-helpers.ts) and the agent-side workspace path guard
 * (agent/workspace-path-guard.ts).
 *
 * A purely lexical `resolve` + `relative` check is not enough for paths that
 * may contain symlinks: a symlink planted inside an allowed root (e.g. by the
 * agent's bash tool inside a workspace) lets a request escape to any file on
 * the host. The checks here resolve the closest *existing* ancestor through
 * `realpathSync` and project the non-existent suffix from there, so symlink
 * escapes are caught for both reads and writes.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function findExistingAncestor(target: string): string | null {
	let current = target;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return current;
}

/**
 * Canonicalize a containment root. The root itself may contain symlink
 * components (e.g. macOS /tmp → /private/tmp); children's realpaths never
 * match a non-canonical root, which would silently reject every legitimate
 * path. Falls back to the lexical path when the root does not exist yet.
 */
export function canonicalContainmentRoot(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/**
 * Resolve `userPath` against `baseDir` and verify that the canonical
 * (symlink-resolved) target stays inside the canonical base. Returns the
 * lexically resolved path (not the canonical one — callers keep their
 * existing path semantics) or null when the path escapes.
 */
export function resolveContainedPath(baseDir: string, userPath: string): string | null {
	try {
		const resolvedBase = resolve(baseDir);
		const resolvedPath = resolve(resolvedBase, userPath);
		// Fast lexical reject before touching the filesystem.
		if (!isWithin(resolvedBase, resolvedPath)) return null;

		const canonicalBase = canonicalContainmentRoot(resolvedBase);
		const existingAncestor = findExistingAncestor(resolvedPath);
		if (!existingAncestor) return null;

		const canonicalAncestor = realpathSync(existingAncestor);
		const unresolvedSuffix = relative(existingAncestor, resolvedPath);
		const canonicalTarget = resolve(canonicalAncestor, unresolvedSuffix);
		if (!isWithin(canonicalBase, canonicalTarget)) return null;

		return resolvedPath;
	} catch {
		return null;
	}
}
