import process from "node:process";

import { buildSite, createDevServer, previewSite } from "./site";

const [command = "dev", rootArg] = process.argv.slice(2);
const root = rootArg || process.cwd();

async function main() {
  if (command === "build") {
    const result = await buildSite(root);
    console.log(
      `TNotes SSG built ${result.pageCount} pages into ${result.config.outDir}`,
    );
    return;
  }
  if (command === "preview") {
    const server = await previewSite(root);
    server.printUrls();
    return;
  }
  if (command === "dev") {
    const server = await createDevServer(root);
    server.printUrls();
    return;
  }
  throw new Error(`Unknown command: ${command}. Use dev, build, or preview.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
