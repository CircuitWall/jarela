#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

const ROUTES_ROOT = path.join(
  process.cwd(),
  ".next",
  "standalone",
  ".next",
  "server",
  "app",
  "api"
);

const MAX_ALLOWED_LINE_LENGTH = Number(
  process.env.JARELA_ROUTE_MAX_LINE_LENGTH ?? 20000
);

const invocationRules = [
  {
    name: "child_process method invocation",
    regex:
      /(?:child_process|childProcess)\s*\.\s*(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/g,
  },
  {
    name: "require(node:child_process).method invocation",
    regex:
      /require\((['\"])(?:node:)?child_process\1\)\s*\.\s*(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/g,
  },
  {
    name: "direct eval invocation",
    regex: /(?:^|[^\w$])eval\s*\(/g,
  },
];

async function listRouteBundles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return listRouteBundles(fullPath);
      }
      return entry.name === "route.js" ? [fullPath] : [];
    })
  );
  return files.flat();
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function countMatches(content, regex) {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(content)) {
    count += 1;
  }
  return count;
}

function normalizePath(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  return rel.split(path.sep).join("/");
}

async function main() {
  if (!(await exists(ROUTES_ROOT))) {
    console.error(
      "[route-bundles] Missing build output at .next/standalone/.next/server/app/api. Run `npm run build` first."
    );
    process.exit(1);
  }

  const routeFiles = await listRouteBundles(ROUTES_ROOT);
  if (routeFiles.length === 0) {
    console.error("[route-bundles] No route.js bundles found under standalone output.");
    process.exit(1);
  }

  const findings = [];
  let maxLineSeen = 0;
  let totalMaps = 0;

  for (const filePath of routeFiles) {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const maxLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const fileFindings = [];

    if (maxLine > MAX_ALLOWED_LINE_LENGTH) {
      fileFindings.push(
        `max line ${maxLine} exceeds threshold ${MAX_ALLOWED_LINE_LENGTH}`
      );
    }

    for (const rule of invocationRules) {
      const matches = countMatches(content, rule.regex);
      if (matches > 0) {
        fileFindings.push(`${rule.name} (${matches})`);
      }
    }

    const hasMap = await exists(`${filePath}.map`);
    if (!hasMap) {
      fileFindings.push("missing route source map");
    } else {
      totalMaps += 1;
    }

    maxLineSeen = Math.max(maxLineSeen, maxLine);

    if (fileFindings.length > 0) {
      findings.push({
        file: normalizePath(filePath),
        reasons: fileFindings,
      });
    }
  }

  console.log(
    `[route-bundles] scanned ${routeFiles.length} route bundles; max line ${maxLineSeen}; source maps ${totalMaps}/${routeFiles.length}`
  );

  if (findings.length > 0) {
    console.error("[route-bundles] Findings:");
    for (const finding of findings) {
      console.error(`- ${finding.file}`);
      for (const reason of finding.reasons) {
        console.error(`  * ${reason}`);
      }
    }
    process.exit(1);
  }

  console.log("[route-bundles] PASS: no risky route bundle findings.");
}

main().catch((error) => {
  console.error("[route-bundles] Failed:", error);
  process.exit(1);
});
