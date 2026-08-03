import { useEffect, useRef, useState } from "react";

type ChangeStore = {
	on(event: "change", fn: () => void): () => void;
};

/**
 * Shallow equality for store snapshots. Stores emit "change" for any field
 * update, but a component's snapshot often picks fields that didn't change —
 * returning the previous state in that case lets React skip the re-render
 * entirely (this is what keeps high-frequency streaming emits from
 * re-rendering the whole chat view 25 times a second).
 */
function snapshotEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
	const aRecord = a as Record<string, unknown>;
	const bRecord = b as Record<string, unknown>;
	const aKeys = Object.keys(aRecord);
	if (aKeys.length !== Object.keys(bRecord).length) return false;
	return aKeys.every((key) => Object.is(aRecord[key], bRecord[key]));
}

export function useStoreSnapshot<TStore extends ChangeStore, TSnapshot>(
	store: TStore,
	getSnapshot: () => TSnapshot,
): TSnapshot {
	const getSnapshotRef = useRef(getSnapshot);
	const [snapshot, setSnapshot] = useState(getSnapshot);
	getSnapshotRef.current = getSnapshot;

	useEffect(() => {
		setSnapshot((prev) => {
			const next = getSnapshotRef.current();
			return snapshotEqual(prev, next) ? prev : next;
		});
		return store.on("change", () => {
			setSnapshot((prev) => {
				const next = getSnapshotRef.current();
				return snapshotEqual(prev, next) ? prev : next;
			});
		});
	}, [store]);

	return snapshot;
}
