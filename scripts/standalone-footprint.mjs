import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

function napiDir(standalone) {
  return join(standalone, "node_modules", "onnxruntime-node", "bin", "napi-v6");
}

/**
 * Remove files the standalone tracer copies but the server never loads:
 * `.git` (traced because the self-update route probes `<cwd>/.git`),
 * onnxruntime-node binaries for other platforms (traced through the binding
 * loader's `${process.platform}/${process.arch}` template), and the browser
 * ONNX backend. Bundles are built on their target platform, so only the
 * running platform's binding is kept. Returns the removed paths.
 */
export function pruneStandaloneFootprint(standalone, { platform = process.platform, arch = process.arch } = {}) {
  const removed = [];
  const remove = (path) => {
    if (!existsSync(path)) return;
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed.push(path);
  };
  remove(join(standalone, ".git"));
  remove(join(standalone, "node_modules", "onnxruntime-web"));
  const bins = napiDir(standalone);
  if (existsSync(bins)) {
    for (const os of readdirSync(bins, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      if (os.name !== platform) {
        remove(join(bins, os.name));
        continue;
      }
      for (const cpu of readdirSync(join(bins, os.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
        if (cpu.name !== arch) remove(join(bins, os.name, cpu.name));
      }
    }
  }
  return removed;
}

/**
 * Return problems that would bloat or break the standalone bundle: a traced
 * `.git` directory, missing or foreign onnxruntime-node binaries, or a heavy
 * runtime that should be installed on demand (ADR-0122). An empty array means
 * the footprint is valid.
 *
 * The embedding stack and the Copilot SDK are no longer dependencies, so their
 * absence is the expected state; if a checkout still has them installed they
 * must at least be pruned to the running platform's binding.
 */
export function findStandaloneFootprintProblems(standalone, { platform = process.platform, arch = process.arch } = {}) {
  const problems = [];
  if (existsSync(join(standalone, ".git"))) {
    problems.push(".git was traced into the standalone bundle");
  }

  for (const [dir, label] of [
    [join(standalone, "node_modules", "@huggingface", "transformers"), "@huggingface/transformers"],
    [join(standalone, "node_modules", "@microsoft", "copilot-sdk"), "@microsoft/copilot-sdk"],
  ]) {
    if (existsSync(dir)) {
      problems.push(`${label} should be installed on demand, not bundled`);
    }
  }

  const bins = napiDir(standalone);
  const hasOnnx = existsSync(join(standalone, "node_modules", "onnxruntime-node"));
  if (hasOnnx && !existsSync(join(bins, platform, arch, "onnxruntime_binding.node"))) {
    problems.push(`onnxruntime-node binding for ${platform}/${arch} is missing`);
  }
  if (existsSync(bins)) {
    for (const os of readdirSync(bins, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const cpu of readdirSync(join(bins, os.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
        if (os.name !== platform || cpu.name !== arch) {
          problems.push(`onnxruntime-node binaries for ${os.name}/${cpu.name} should not be bundled`);
        }
      }
    }
  }

  if (existsSync(join(standalone, "node_modules", "onnxruntime-web"))) {
    problems.push("onnxruntime-web (browser backend) should not be bundled");
  }
  return problems;
}
