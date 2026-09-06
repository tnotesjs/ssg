import "@tnotesjs/ui/styles/tokens.css";
import "@tnotesjs/ui/styles/prose.css";
import "@tnotesjs/ui/styles/code.css";
import "@tnotesjs/ui/styles/swiper.css";
import "./theme.css";

import site from "virtual:tnotes-site";

import { resolveNotePath, stripBase } from "../noteRoute";
import { createSiteApp } from "./runtime";

const canonical = resolveNotePath(location.pathname, site.notes, site.base);
if (canonical && stripBase(location.pathname, site.base) !== canonical) {
  location.replace(
    `${site.base}${canonical.slice(1)}${location.search}${location.hash}`,
  );
} else {
  const root = document.querySelector<HTMLElement>("#app");
  if (root) {
    const route = root.dataset.route || "/";
    void createSiteApp(route).then(({ app }) => app.mount(root));
  }
}
