import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

function sourceImports(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const modules: string[] = [];
  const add = (specifier: ts.Expression | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) modules.push(specifier.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return modules;
}

function resolvesInside(path: string, forbiddenRoot: string): boolean {
  const pathFromRoot = relative(repositoryRoot, path);
  return (
    pathFromRoot === forbiddenRoot ||
    pathFromRoot.startsWith(`${forbiddenRoot}${sep}`)
  );
}

test("Runtime production dependencies contain only Engine Contract", () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["@anyagent/engine-contract"]);
});

test("Runtime source imports stay within its allowed package boundary", () => {
  const sourceRoot = resolve(packageRoot, "src");
  const imports = sourceFiles(sourceRoot).flatMap((filePath) =>
    sourceImports(filePath).map((specifier) => ({ filePath, specifier })),
  );
  const violations = imports.filter(({ filePath, specifier }) => {
    if (
      specifier.startsWith("@zcode/") ||
      specifier === "packages/services" ||
      specifier.startsWith("packages/services/") ||
      specifier === "packages/desktop" ||
      specifier.startsWith("packages/desktop/") ||
      specifier.startsWith("apps/")
    )
      return true;
    if (!specifier.startsWith(".")) return false;
    const importedPath = resolve(dirname(filePath), specifier);
    return (
      resolvesInside(importedPath, "apps") ||
      resolvesInside(importedPath, "packages/services") ||
      resolvesInside(importedPath, "packages/desktop")
    );
  });
  assert.deepEqual(violations, []);
});
