#!/usr/bin/env node
// One-shot survey: find function-like declarations with body LOC > THRESHOLD.
// Uses the TypeScript compiler API for accurate AST-based detection.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const THRESHOLD = Number(process.env.LOC_THRESHOLD ?? 50);

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "test-results",
  "playwright-report",
  "browser-extension",
  "public",
  "dist",
  "build",
  ".vscode",
  "scripts",
]);

const EXTS = new Set([".ts", ".tsx"]);

/** @type {{file:string; name:string; kind:string; start:number; end:number; loc:number}[]} */
const results = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      if (entry.name !== ".") continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTS.has(path.extname(entry.name))) continue;
    if (/\.(test|spec|d)\.tsx?$/.test(entry.name)) continue;
    analyzeFile(full);
  }
}

function lineOf(source, pos) {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function declaredName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText() ?? "<anonymous>";
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.name) {
      return parent.name.getText();
    }
    if (parent && ts.isPropertyAssignment(parent) && parent.name) {
      return parent.name.getText();
    }
    if (parent && ts.isPropertyDeclaration(parent) && parent.name) {
      return parent.name.getText();
    }
    if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return parent.left.getText();
    }
    if (parent && ts.isCallExpression(parent)) {
      // try grandparent variable
      const gp = parent.parent;
      if (gp && ts.isVariableDeclaration(gp) && gp.name) return gp.name.getText() + " (wrapped)";
      return "<callback>";
    }
    return "<anonymous>";
  }
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return node.name.getText();
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return "<unknown>";
}

function kindOf(node) {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isFunctionExpression(node)) return "function-expr";
  if (ts.isArrowFunction(node)) return "arrow";
  if (ts.isGetAccessor(node)) return "getter";
  if (ts.isSetAccessor(node)) return "setter";
  if (ts.isConstructorDeclaration(node)) return "ctor";
  return node.kind.toString();
}

function isFnLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function analyzeFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

  const visit = (node) => {
    if (isFnLike(node) && node.body) {
      const body = node.body;
      const startLine = lineOf(source, body.getStart(source));
      const endLine = lineOf(source, body.getEnd());
      const loc = endLine - startLine + 1;
      if (loc > THRESHOLD) {
        const headerLine = lineOf(source, node.getStart(source));
        results.push({
          file: path.relative(ROOT, filePath).replace(/\\/g, "/"),
          name: declaredName(node),
          kind: kindOf(node),
          start: headerLine,
          end: endLine,
          loc,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

walk(ROOT);

results.sort((a, b) => b.loc - a.loc);

const asJson = process.argv.includes("--json");
if (asJson) {
  process.stdout.write(JSON.stringify(results, null, 2));
} else {
  console.log(`Functions with body > ${THRESHOLD} LOC (${results.length} hits)`);
  console.log("LOC\tKIND\tNAME\tFILE:START-END");
  for (const r of results) {
    console.log(`${r.loc}\t${r.kind}\t${r.name}\t${r.file}:${r.start}-${r.end}`);
  }
}
