import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SOURCE_DIRS = ['components', 'entrypoints', 'lib'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
}

/**
 * `t()` returns the active catalog. Calling it while a module is evaluated
 * would freeze that string in whatever locale was active at import time, so
 * every call must sit inside a function, method or component body. A page's
 * boot script (`entrypoints/<page>/main.tsx`) is exempt: it runs once per page
 * load, so its module scope lives exactly as long as the page's locale does.
 */
function moduleScopeCalls(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node, insideFunction: boolean) => {
    const inside = insideFunction || isFunctionLike(node);
    if (
      !inside &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 't' &&
      node.arguments.length === 0
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      hits.push(`${path.relative(ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(source, false);
  return hits;
}

describe('i18n usage', () => {
  it('never reads the active catalog at module scope', () => {
    const files = SOURCE_DIRS.flatMap((directory) => sourceFiles(path.join(ROOT, directory))).filter(
      (file) => !/entrypoints[\\/][^\\/]+[\\/]main\.tsx$/.test(file),
    );
    expect(files.flatMap(moduleScopeCalls)).toEqual([]);
  });
});
