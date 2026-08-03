import "./app.css";
import "./i18n/index.js";
import "./stores/theme-store.js";
// Register <markdown-block> explicitly — QuestionDialog depends on it and must not
// rely on pi-web-ui's side-effect import chain (ChatCenter → MarkdownArtifact → mini-lit).
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./react/App.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

console.log("[inno-web] React initialized");
