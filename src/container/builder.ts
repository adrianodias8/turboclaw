import { logger } from "../logger";
import { join } from "path";

export interface BuildOptions {
  tag?: string;
  dockerfilePath?: string;
  contextPath?: string;
  noCache?: boolean;
}

export async function buildWorkerImage(opts: BuildOptions = {}): Promise<{ success: boolean; output: string }> {
  const tag = opts.tag ?? "turboclaw-worker:latest";
  const dockerfile = opts.dockerfilePath ?? join(import.meta.dir, "../../docker/Dockerfile.worker");
  const context = opts.contextPath ?? join(import.meta.dir, "../../docker");

  const args = [
    "build",
    "-t", tag,
    "-f", dockerfile,
    context,
  ];

  if (opts.noCache) {
    args.splice(1, 0, "--no-cache");
  }

  logger.info(`Building worker image: ${tag}`);

  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  const output = stdout + stderr;

  if (exitCode !== 0) {
    logger.error(`Image build failed: ${stderr.slice(0, 500)}`);
    return { success: false, output };
  }

  logger.info(`Image built successfully: ${tag}`);
  return { success: true, output };
}
