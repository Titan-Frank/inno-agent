import { useEffect, useState } from "react";
import { CaseSidebar } from "./components/CaseSidebar.js";
import { ReplayPage } from "./pages/ReplayPage.js";
import { WelcomePage } from "./pages/WelcomePage.js";
import type { CaseMeta } from "./cases.js";
import { fetchCaseIndex } from "./cases.js";

/** Minimal hash routing: "" -> welcome, "#/case/<id>" -> replay player. */
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
	const [cases, setCases] = useState<CaseMeta[] | null>(null);

	useEffect(() => {
		fetchCaseIndex()
			.then(setCases)
			.catch(() => setCases([]));
	}, []);

	const caseMatch = /^#\/case\/([^/]+)$/.exec(hash);
	const activeId = caseMatch ? decodeURIComponent(caseMatch[1]) : undefined;

	// Same frame classes as the product shell (app.css): sidebar column +
	// chat column, workspace column collapsed. .showcase-frame adds the
	// mobile fallback (sidebar hidden, chat full-width).
	return (
		<div className="app-layout app-layout--sidebar-expanded app-layout--workspace-collapsed showcase-frame">
			<CaseSidebar cases={cases} activeId={activeId} />
			{activeId ? <ReplayPage caseId={activeId} /> : <WelcomePage cases={cases} />}
		</div>
	);
}
