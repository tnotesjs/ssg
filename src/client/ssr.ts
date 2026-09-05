import { renderToString } from "@vue/server-renderer";

import { createSiteApp } from "./runtime";

export async function render(route: string) {
  const { app, data } = await createSiteApp(route);
  return { html: await renderToString(app), data };
}
