#!/usr/bin/env node

import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ASSET_ENV_KEYS = Object.freeze({
  logoLight: "NEXT_PUBLIC_APP_LOGO_LIGHT",
  logoDark: "NEXT_PUBLIC_APP_LOGO_DARK",
  faviconSvg: "NEXT_PUBLIC_APP_FAVICON_SVG",
  faviconIco: "NEXT_PUBLIC_APP_FAVICON_ICO",
  icon192: "NEXT_PUBLIC_APP_ICON_192",
  icon512: "NEXT_PUBLIC_APP_ICON_512",
  icon192Maskable: "NEXT_PUBLIC_APP_ICON_192_MASKABLE",
  icon512Maskable: "NEXT_PUBLIC_APP_ICON_512_MASKABLE",
  icon192Light: "NEXT_PUBLIC_APP_ICON_192_LIGHT",
  icon512Light: "NEXT_PUBLIC_APP_ICON_512_LIGHT",
  icon192MaskableLight: "NEXT_PUBLIC_APP_ICON_192_MASKABLE_LIGHT",
  icon512MaskableLight: "NEXT_PUBLIC_APP_ICON_512_MASKABLE_LIGHT",
  appleTouchIcon: "NEXT_PUBLIC_APP_APPLE_TOUCH_ICON",
});

const BRAND_SCHEMA = z.strictObject({
  name: z.string().trim().min(1).max(80),
  shortName: z.string().trim().min(1).max(32).optional(),
  description: z.string().trim().min(1).max(300).optional(),
  systemName: z.string().trim().min(1).max(80).optional(),
  assistantName: z.string().trim().min(1).max(60).optional(),
  assistantIdentity: z.string().trim().min(1).max(2000).optional(),
  issueUrl: z.string().trim().url().max(2048).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must be an absolute HTTP or HTTPS URL").optional(),
  accentColor: z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
  accentHoverColor: z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
  assets: z.record(z.string(), z.string().trim().min(1)).optional(),
});

const ALLOWED_ASSET_EXTENSIONS = new Set([".ico", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const PLACEHOLDER_PATTERN = /\{\{([^{}]+)\}\}/g;
const EXCLUDED_STAGING_DIRS = new Set([
  ".git",
  ".next",
  ".jarela-assets",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function expandPlaceholders(value, values, field) {
  return value.replace(PLACEHOLDER_PATTERN, (_match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`brand.${field} uses unsupported placeholder {{${key}}}`);
    }
    return values[key];
  });
}

function readAsset(configDirectory, key, value) {
  if (!Object.hasOwn(ASSET_ENV_KEYS, key)) {
    throw new Error(`brand.assets contains unknown key "${key}"`);
  }
  if (isAbsolute(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error(`brand.assets.${key} must be a relative local file path`);
  }

  const source = resolve(configDirectory, value);
  if (!isWithin(configDirectory, source)) {
    throw new Error(`brand.assets.${key} must remain inside the brand config directory`);
  }
  const extension = extname(source).toLowerCase();
  if (!ALLOWED_ASSET_EXTENSIONS.has(extension)) {
    throw new Error(`brand.assets.${key} must use SVG, ICO, JPEG, PNG, or WebP`);
  }

  const realDirectory = realpathSync(configDirectory);
  const realSource = realpathSync(source);
  if (!isWithin(realDirectory, realSource)) {
    throw new Error(`brand.assets.${key} must resolve inside the brand config directory`);
  }
  const stat = statSync(realSource);
  if (!stat.isFile()) throw new Error(`brand.assets.${key} must be a regular file`);
  if (stat.size > MAX_ASSET_BYTES) throw new Error(`brand.assets.${key} exceeds the 10 MB limit`);

  const destination = `/branding/${key}${extension}`;
  return { key, source: realSource, destination };
}

export function resolveBrandConfig(configPath) {
  const absoluteConfigPath = resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absoluteConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read brand config ${absoluteConfigPath}: ${error.message}`);
  }
  const parsed = BRAND_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "brand"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid brand config ${absoluteConfigPath}: ${issues}`);
  }

  const input = parsed.data;
  const systemName = input.systemName ?? input.name;
  const assistantName = input.assistantName ?? `${systemName} Assistant`.slice(0, 60);
  const placeholders = { appName: input.name, systemName, assistantName };
  const env = {
    NEXT_PUBLIC_APP_NAME: input.name,
    NEXT_PUBLIC_APP_SHORT_NAME: input.shortName ?? input.name,
    NEXT_PUBLIC_APP_DESCRIPTION: input.description
      ? expandPlaceholders(input.description, placeholders, "description")
      : `${systemName} — local assistant workspace`,
    NEXT_PUBLIC_SYSTEM_NAME: systemName,
    NEXT_PUBLIC_APP_ASSISTANT_NAME: assistantName,
    NEXT_PUBLIC_APP_ASSISTANT_IDENTITY: expandPlaceholders(
      input.assistantIdentity ?? `A friendly, adaptable personal assistant for ${systemName}.`,
      placeholders,
      "assistantIdentity",
    ),
  };
  if (input.issueUrl) env.NEXT_PUBLIC_APP_ISSUE_URL = input.issueUrl;
  if (input.accentColor) env.NEXT_PUBLIC_APP_ACCENT_COLOR = input.accentColor;
  if (input.accentHoverColor) env.NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR = input.accentHoverColor;

  const configDirectory = dirname(absoluteConfigPath);
  const assets = Object.entries(input.assets ?? {}).map(([key, value]) => {
    const asset = readAsset(configDirectory, key, value);
    env[ASSET_ENV_KEYS[key]] = asset.destination;
    return asset;
  });

  return { name: input.name, env, assets };
}

function copyBrandAssets(publicDirectory, assets) {
  for (const asset of assets) {
    const destination = join(publicDirectory, asset.destination.slice(1).split("/").join(sep));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(asset.source, destination);
  }
}

function findNodeModulesDirectory(nextBinary) {
  let directory = dirname(nextBinary);
  while (directory !== dirname(directory)) {
    if (basename(directory) === "node_modules") return directory;
    directory = dirname(directory);
  }
  throw new Error(`could not locate the installed node_modules directory for ${nextBinary}`);
}

function copyPackageSource(destination) {
  cpSync(packageRoot, destination, {
    recursive: true,
    filter: (source) => {
      const path = relative(packageRoot, source);
      if (!path) return true;
      const segments = path.split(sep);
      if (segments.some((segment) => EXCLUDED_STAGING_DIRS.has(segment))) return false;
      return !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(source);
    },
  });
}

function runBuild(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function replaceStandalone(builtStandalone) {
  const nextDirectory = join(packageRoot, ".next");
  const destination = join(nextDirectory, "standalone");
  const buildId = randomUUID();
  const replacement = join(nextDirectory, `.standalone-brand-${buildId}`);
  const backup = join(nextDirectory, `.standalone-brand-backup-${buildId}`);
  mkdirSync(nextDirectory, { recursive: true });
  rmSync(replacement, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  cpSync(builtStandalone, replacement, { recursive: true });

  let movedOldBundle = false;
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedOldBundle = true;
    }
    renameSync(replacement, destination);
    if (movedOldBundle) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(destination) && movedOldBundle && existsSync(backup)) {
      renameSync(backup, destination);
    }
    throw error;
  } finally {
    rmSync(replacement, { recursive: true, force: true });
  }
}

export async function buildBrandedApp({ brandFile, quiet = false } = {}) {
  const brandPath = resolve(brandFile ?? join(process.cwd(), "brand.json"));
  const brand = resolveBrandConfig(brandPath);
  const require = createRequire(join(packageRoot, "package.json"));
  const nextBinary = require.resolve("next/dist/bin/next");
  const nodeModulesDirectory = findNodeModulesDirectory(nextBinary);
  const stagingDirectory = mkdtempSync(join(tmpdir(), "jarela-branded-build-"));

  try {
    copyPackageSource(stagingDirectory);
    symlinkSync(
      nodeModulesDirectory,
      join(stagingDirectory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    copyBrandAssets(join(stagingDirectory, "public"), brand.assets);

    const env = {
      ...process.env,
      ...brand.env,
      NODE_ENV: "production",
    };
    if (!quiet) {
      console.log(`[brand] Building ${brand.name} outside node_modules...`);
    }
    runBuild(process.execPath, [nextBinary, "build", "--webpack"], {
      cwd: stagingDirectory,
      env,
    });
    runBuild(process.execPath, [join(stagingDirectory, "scripts", "postbuild.mjs")], {
      cwd: stagingDirectory,
      env,
    });

    const builtStandalone = join(stagingDirectory, ".next", "standalone");
    if (!existsSync(join(builtStandalone, "server.js"))) {
      throw new Error("Next.js build completed without producing a standalone server");
    }
    replaceStandalone(builtStandalone);
    if (!quiet) {
      console.log(`[brand] Built ${brand.name}. Run \`jarela start\` to launch it.`);
    }
    return { name: brand.name, standalone: join(packageRoot, ".next", "standalone") };
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--brand") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--brand requires a config file path");
      options.brandFile = resolve(value);
      index += 1;
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${argv[index]}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: jarela build-branded [--brand ./brand.json]");
    } else {
      await buildBrandedApp(options);
    }
  } catch (error) {
    console.error(`[brand] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
