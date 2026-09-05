import "@tnotesjs/ui/styles/tokens.css";
import "@tnotesjs/ui/styles/prose.css";
import "@tnotesjs/ui/styles/code.css";
import "./theme.css";

import { createSiteApp } from "./runtime";

const root = document.querySelector<HTMLElement>("#app");
if (root) {
  const route = root.dataset.route || "/";
  createSiteApp(route).then(({ app }) => app.mount(root));
}
