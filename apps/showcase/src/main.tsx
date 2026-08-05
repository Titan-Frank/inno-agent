// Reuse the main app's full stylesheet (pi-web-ui css + tailwind + themes +
// .inno-message chat styles) so replayed conversations look exactly like the
// real product, and stay in sync as the product UI evolves.
import "@inno-web/app.css";
import "./i18n.js";
import "./showcase.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
