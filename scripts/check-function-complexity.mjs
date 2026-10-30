#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const MAX_FUNCTION_LINES = 150;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(repoRoot, "scripts", "function-complexity-baseline.json");
const excludedDirectories = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", "site",
  "tests", "__tests__", "__fixtures__", "fixtures", "test-results", ".turbo", ".cache",
]);

export function isProductionSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return /\.(?:[cm]?ts|tsx)$/.test(normalized)
    && !/\.d\.[cm]?ts$/.test(normalized)
    && !/\.(?:test|spec)\.[cm]?tsx?$/.test(normalized)
    && !normalized.split("/").some((part) => excludedDirectories.has(part));
}

export function collectSourceFiles(root, relative = "") {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) return excludedDirectories.has(entry.name) ? [] : collectSourceFiles(root, file);
      return entry.isFile() && isProductionSource(file) ? [file] : [];
    }).sort();
}

function functionName(node, source) {
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText(source);
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return `${parent.expression.getText(source)}[${parent.arguments.indexOf(node)}]`;
  }
  return "anonymous";
}

export function measureFunctions(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) {
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, "\n")}`);
  }
  const measurements = [];
  function visit(node, scope, counts) {
    const isFunction = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
    if (isFunction && node.body) {
      const name = ts.isConstructorDeclaration(node) ? "constructor" : functionName(node, source);
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      const identity = [...scope, `${name}#${count}`];
      const start = source.getLineAndCharacterOfPosition(node.body.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.body.end - 1).line;
      measurements.push({
        id: `${file.replaceAll("\\", "/")}::${identity.join("/")}`,
        file, name: identity.join("/"), line: start + 1, lines: end - start + 1,
      });
      ts.forEachChild(node, (child) => visit(child, identity, new Map()));
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.getText(source) ?? functionName(node, source);
      const classCounts = new Map();
      ts.forEachChild(node, (child) => visit(child, [...scope, name], classCounts));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, scope, counts));
  }
  visit(source, [], new Map());
  return measurements;
}

export function checkBaseline(measurements, baseline) {
  if (baseline?.schemaVersion !== 1 || baseline.maxLines !== MAX_FUNCTION_LINES
    || !baseline.functions || typeof baseline.functions !== "object" || Array.isArray(baseline.functions)
    || !Object.values(baseline.functions).every((lines) => Number.isInteger(lines) && lines > MAX_FUNCTION_LINES)) {
    throw new Error("Invalid function complexity baseline");
  }
  const errors = [];
  const remaining = new Set(Object.keys(baseline.functions));
  for (const measurement of measurements) {
    const allowed = baseline.functions[measurement.id];
    remaining.delete(measurement.id);
    if (measurement.lines > (allowed ?? MAX_FUNCTION_LINES)) {
      errors.push(`${measurement.file}:${measurement.line} ${measurement.name}: ${measurement.lines} lines (limit ${allowed ?? MAX_FUNCTION_LINES})`);
    } else if (allowed !== undefined && measurement.lines < allowed) {
      errors.push(`${measurement.id}: reduce the baseline from ${allowed} to ${measurement.lines > MAX_FUNCTION_LINES ? measurement.lines : "no exception"}`);
    }
  }
  for (const id of remaining) errors.push(`${id}: remove stale baseline entry`);
  return errors;
}

export function createBaseline(measurements) {
  return {
    schemaVersion: 1,
    maxLines: MAX_FUNCTION_LINES,
    functions: Object.fromEntries(measurements
      .filter(({ lines }) => lines > MAX_FUNCTION_LINES)
      .sort((a, b) => a.id.localeCompare(b.id, "en"))
      .map(({ id, lines }) => [id, lines])),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--write-baseline")) throw new Error("Usage: check-function-complexity.mjs [--write-baseline]");
  const measurements = collectSourceFiles(repoRoot)
    .flatMap((file) => measureFunctions(file, fs.readFileSync(path.join(repoRoot, file), "utf8")));
  if (args.includes("--write-baseline")) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(createBaseline(measurements), null, 2)}\n`);
    console.log("[function-complexity] Wrote baseline; review every added or increased exception before committing.");
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const errors = checkBaseline(measurements, baseline);
  if (errors.length) {
    console.error(`[function-complexity] ${errors.length} violations:\n${errors.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`[function-complexity] ${measurements.length} functions checked; ${Object.keys(baseline.functions).length} existing exceptions, no growth.`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (error) {
    console.error(`[function-complexity] ${error.message}`);
    process.exitCode = 1;
  }
}
