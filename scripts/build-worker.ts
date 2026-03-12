import { buildWorkerImage } from "../src/container/builder";

const noCache = process.argv.includes("--no-cache");

const result = await buildWorkerImage({ noCache });

if (!result.success) {
  console.error("Build failed.");
  process.exit(1);
}

console.log("Worker image built successfully.");
