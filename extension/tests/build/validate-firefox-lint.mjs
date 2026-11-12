import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { cmd } from 'web-ext';

const sourceRoot = process.cwd();
const firefoxOutput = path.join(sourceRoot, '.output/firefox-mv2');
const firstPartyRoots = ['components', 'entrypoints', 'lib'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(absolute)));
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = node.argumentExpression;
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
  return null;
}

function findUnsafeHtmlOperations(file, source) {
  const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const findings = [];

  const report = (node, operation) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push(`${path.relative(sourceRoot, file)}:${position.line + 1}:${position.character + 1} ${operation}`);
  };
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'dangerouslySetInnerHTML') {
      report(node, 'uses dangerouslySetInnerHTML');
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const assigned = propertyName(node.left);
      if (assigned === 'innerHTML') report(node, 'assigns innerHTML');
      if (assigned === 'outerHTML') report(node, 'assigns outerHTML');
    }
    if (ts.isCallExpression(node)) {
      const callee = propertyName(node.expression);
      if (callee === 'insertAdjacentHTML') report(node, 'calls insertAdjacentHTML');
      if (callee === 'createContextualFragment') report(node, 'calls createContextualFragment');
      if (callee === 'write' || callee === 'writeln') {
        const receiver = node.expression.expression?.getText(sourceFile) ?? '';
        if (receiver === 'document' || receiver.endsWith('.document')) {
          report(node, `calls document.${callee}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

async function assertFirstPartyHtmlSafety() {
  const files = (
    await Promise.all(firstPartyRoots.map((directory) => collectSourceFiles(path.join(sourceRoot, directory))))
  ).flat();
  const findings = [];
  for (const file of files) findings.push(...findUnsafeHtmlOperations(file, await readFile(file, 'utf8')));
  if (findings.length > 0) {
    throw new Error(`First-party unsafe HTML operations are forbidden:\n${findings.join('\n')}`);
  }
}

function isVerifiedReactRendererWarning(warning, generatedSource) {
  // Any generated bundle file qualifies (Vite's chunk naming isn't stable), but
  // the exemption stays narrow: the real gate is the source check plus
  // assertFirstPartyHtmlSafety, which forbid these operations in components/,
  // entrypoints/ and lib/ outright.
  if (
    warning.code !== 'UNSAFE_VAR_ASSIGNMENT' ||
    warning.message !== 'Unsafe assignment to innerHTML' ||
    !Number.isSafeInteger(warning.line) ||
    !Number.isSafeInteger(warning.column) ||
    !(/^chunks\/[A-Za-z0-9_.-]+\.js$/u.test(warning.file) || warning.file === 'content-scripts/content.js')
  )
    return false;

  const line = generatedSource.split(/\r?\n/u)[warning.line - 1];
  if (!line) return false;
  const index = Math.max(0, warning.column - 1);
  const context = line.slice(Math.max(0, index - 320), index + 160);
  return context.includes('dangerouslySetInnerHTML') && context.includes('__html') && context.includes('.innerHTML=');
}

async function runFirefoxLint() {
  // web-ext prints its JSON result even when used programmatically. Capture that
  // implementation detail so CI emits only the reviewed, actionable summary.
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await cmd.lint(
      {
        artifactsDir: path.join(sourceRoot, 'web-ext-artifacts'),
        boring: true,
        ignoreFiles: [],
        metadata: false,
        output: 'json',
        pretty: false,
        privileged: false,
        selfHosted: false,
        sourceDir: firefoxOutput,
        verbose: false,
        warningsAsErrors: false,
      },
      { shouldExitProgram: false },
    );
  } finally {
    console.log = originalLog;
  }
}

await assertFirstPartyHtmlSafety();
const result = await runFirefoxLint();
if (!result || !Array.isArray(result.errors) || !Array.isArray(result.warnings)) {
  throw new Error('Firefox add-on linter returned an invalid result.');
}
if (result.errors.length > 0) {
  throw new Error(`Firefox add-on lint errors:\n${JSON.stringify(result.errors, null, 2)}`);
}

const acknowledged = [];
const unexpected = [];
for (const warning of result.warnings) {
  let generatedSource = '';
  try {
    generatedSource = await readFile(path.join(firefoxOutput, warning.file), 'utf8');
  } catch {
    unexpected.push(warning);
    continue;
  }
  if (isVerifiedReactRendererWarning(warning, generatedSource)) acknowledged.push(warning);
  else unexpected.push(warning);
}
if (unexpected.length > 0) {
  throw new Error(`Unexpected Firefox add-on lint warnings:\n${JSON.stringify(unexpected, null, 2)}`);
}

console.log(
  `Firefox add-on lint passed: 0 errors, 0 actionable warnings` +
    ` (${acknowledged.length} verified React renderer false positives isolated).`,
);
