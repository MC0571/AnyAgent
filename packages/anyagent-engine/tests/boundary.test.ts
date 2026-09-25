import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
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

test("Engine Contract has no production dependencies", () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("Engine Contract source imports stay within its package boundary", () => {
  const sourceRoot = resolve(packageRoot, "src");
  const imports = sourceFiles(sourceRoot).flatMap((filePath) =>
    sourceImports(filePath).map((specifier) => ({ filePath, specifier })),
  );
  const violations = imports.filter(({ filePath, specifier }) => {
    if (specifier.startsWith("@zcode/") || specifier.startsWith("packages/") || specifier.startsWith("apps/"))
      return true;
    if (!specifier.startsWith(".")) return false;
    const importedPath = resolve(dirname(filePath), specifier);
    const withinPackage = relative(packageRoot, importedPath);
    if (withinPackage === "" || (!withinPackage.startsWith("..") && !isAbsolute(withinPackage)))
      return false;
    const pathFromRoot = relative(repositoryRoot, importedPath);
    return (
      pathFromRoot === "apps" ||
      pathFromRoot.startsWith(`apps${sep}`) ||
      pathFromRoot === "packages" ||
      pathFromRoot.startsWith(`packages${sep}`)
    );
  });
  assert.deepEqual(violations, []);
});
