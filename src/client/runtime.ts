import { createSSRApp } from "vue";
import { pageData, pages } from "virtual:tnotes-pages";
import site from "virtual:tnotes-site";

import App from "./App.vue";
import { registerTNotesComponents } from "./register";

export async function createSiteApp(route: string) {
  const loader = pages[route] ?? pages["/404"];
  if (!loader) throw new Error(`No page registered for route: ${route}`);
  const page = await loader();
  const data = pageData[route] ?? pageData["/404"];
  const app = createSSRApp(App, { page: page.default, route, data });
  registerTNotesComponents(app, site, pageData);
  return { app, data };
}
