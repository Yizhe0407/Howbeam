import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceRoots = ['components', 'entrypoints', 'lib'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ignoredDirectories = new Set(['node_modules', '.output', 'test-results']);
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
// Dynamic imports (`import('...')`) cross module boundaries just as statically
// imported code does, so they are held to the same rules.
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function normalized(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

// Pure schema/constants modules (importing only lib/shared) that storage/models
// may depend on as peers. The existence check below fails loudly if one is renamed.
const storageModelModules = new Set([
  'lib/storage/models.ts',
  'lib/storage/project-section-model.ts',
  'lib/storage/persistence-limits.ts',
  'lib/storage/image-edit-model.ts',
  'lib/storage/stored-text.ts',
]);

function classify(file) {
  const relative = normalized(file);
  if (relative.startsWith('lib/shared/')) return 'shared-lib';
  if (relative.startsWith('components/ui/')) return 'ui-component';
  if (storageModelModules.has(relative)) return 'storage-models';
  if (relative.startsWith('lib/')) return 'domain-lib';
  if (relative.startsWith('entrypoints/')) return 'entrypoint';
  return 'other';
}

/**
 * Repo-relative target path for a specifier, so relative imports are held to
 * the same rules as @/ aliases. Bare package specifiers return null.
 */
function targetOf(from, specifier) {
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (specifier.startsWith('.')) return normalized(path.resolve(path.dirname(from), specifier));
  return null;
}

function entrypointName(target) {
  return target.split('/')[1]?.replace(/\.(ts|tsx)$/, '') ?? '';
}

function boundaryViolation(from, target) {
  switch (classify(from)) {
    case 'shared-lib':
      return target.startsWith('lib/shared/') ? null : 'lib/shared may only import lib/shared modules';
    case 'ui-component':
      return target.startsWith('components/ui/') || target.startsWith('components/shared/') || target.startsWith('lib/shared/')
        ? null
        : 'components/ui may not depend on feature components or lib domains';
    case 'storage-models':
      return (target.startsWith('lib/storage/') || target.startsWith('lib/project/'))
        && !storageModelModules.has(target) && !storageModelModules.has(`${target}.ts`)
        ? 'storage/models must stay independent of repositories, database, and project services'
        : null;
    case 'domain-lib':
      return target.startsWith('components/')
        ? 'lib modules must not depend on components; keep UI local to lib or lift the dependency into the component layer'
        : null;
    case 'entrypoint':
      return target.startsWith('entrypoints/') && entrypointName(target) !== entrypointName(normalized(from))
        ? 'entrypoints must stay isolated from each other; share code through lib or components instead'
        : null;
    default:
      return null;
  }
}

const files = (await Promise.all(sourceRoots.map((directory) => collectFiles(path.join(root, directory))))).flat();
const knownFiles = new Set(files);
function resolveModule(from, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = path.join(root, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .find((candidate) => knownFiles.has(candidate)) ?? null;
}

const knownRelativePaths = new Set(files.map(normalized));
const missingStorageModelModules = [...storageModelModules].filter((module) => !knownRelativePaths.has(module));
if (missingStorageModelModules.length > 0) {
  throw new Error(
    'storageModelModules lists files that no longer exist (renamed or removed?); update the list:\n' +
    missingStorageModelModules.map((module) => `- ${module}`).join('\n'),
  );
}

const graph = new Map(files.map((file) => [file, []]));
const violations = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of [...source.matchAll(importPattern), ...source.matchAll(dynamicImportPattern)]) {
    const specifier = match[1];
    const resolved = resolveModule(file, specifier);
    const target = resolved ? normalized(resolved) : targetOf(file, specifier);
    if (target) {
      const violation = boundaryViolation(file, target);
      if (violation) violations.push(`${normalized(file)} -> ${specifier}: ${violation}`);
    }
    if (resolved) graph.get(file).push(resolved);
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = new Set();
function visit(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.add([...stack.slice(start), file].map(normalized).join(' -> '));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file);

if (violations.length || cycles.size) {
  const sections = [];
  if (violations.length) sections.push(`Import-boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}`);
  if (cycles.size) sections.push(`Dependency cycles:\n${[...cycles].map((line) => `- ${line}`).join('\n')}`);
  throw new Error(sections.join('\n\n'));
}

console.log(`Module boundaries are valid; scanned ${files.length} source modules with 0 dependency cycles.`);
