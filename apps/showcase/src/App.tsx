import { useEffect, useState } from "react";
import { CaseListPage } from "./pages/CaseListPage.js";
import { ReplayPage } from "./pages/ReplayPage.js";

/** Minimal hash routing: "" -> case list, "#/case/<id>" -> replay player. */
function useHashRoute(): string {
	const [hash, setHash] = useState(() => window.location.hash);
	useEffect(() => {
		const onChange = () => setHash(window.location.hash);
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return hash;
}

export function App() {
	const hash = useHashRoute();
	const caseMatch = /^#\/case\/([^/]+)$/.exec(hash);
	if (caseMatch) {
		return <ReplayPage caseId={decodeURIComponent(caseMatch[1])} />;
	}
	return <CaseListPage />;
}
