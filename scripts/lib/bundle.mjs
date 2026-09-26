// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R1 (MIN-227): the single-file bundler the release uses in place of esbuild,
// which this repository cannot fetch offline. From an entry it follows every relative import,
// export ... from and import() through the build output and writes one ES module in which each
// module keeps a function scope of its own. Modules reach one another through their exports
// objects, the way CommonJS modules do: a module is evaluated once, before the first module that
// imports it; an import cycle sees the functions of a module that has not finished (they are bound
// first); an imported binding is read from the exporting module every time, so it stays live; and
// export * copies live bindings. Only node: built-ins stay outside the file, loaded through
// process.getBuiltinModule, so the bundle has no import of its own. A bare specifier that is not a
// node: built-in is refused with BUNDLE_EXTERNAL_DEPENDENCY: the engine has no runtime dependency,
// and a bundle that needed node_modules would not run where it is installed.
//
// Each module is rewritten by the TypeScript compiler this repository already pins as a
// devDependency (nothing is added and nothing is fetched): its module syntax becomes exports
// assignments and require calls, and the bundler then turns each require of a bundled module into a
// lookup by number. A file a module reads beside itself through new URL("<relative path>",
// import.meta.url) is carried inside the bundle when it exists at bundle time; the bundle's
// node:fs readFileSync and existsSync and node:fs/promises readFile answer for it. Every other use
// of import.meta names the bundle file, as a native module would. Only the entry may use top-level
// await, because a require cannot wait for a module; the entry's exports become the bundle's, read
// once the entry has finished.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

export const BUNDLE_REASON_CODES = Object.freeze([
  "BUNDLE_EXTERNAL_DEPENDENCY",
  "BUNDLE_MODULE_NOT_FOUND",
  "BUNDLE_MODULE_UNSUPPORTED",
  "BUNDLE_NAME_COLLISION",
  "BUNDLE_OUTSIDE_ROOT",
  "BUNDLE_RESERVED_NAME",
  "BUNDLE_SYNTAX_ERROR",
  "BUNDLE_TOP_LEVEL_AWAIT_UNSUPPORTED",
  "BUNDLE_USAGE",
]);

export class BundleError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "BundleError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

// Every name the bundle adds begins with this prefix, and a module whose text already holds it is
// refused, so no module can shadow a name of the bundle's.
const PREFIX = "__einzbernBundle";
// The scheme of the URL a carried file is read through; it never reaches the file system.
const FILE_SCHEME = "einzbern-bundle:";
const MODULE_EXTENSIONS = new Set([".js", ".mjs"]);
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/u;

// The rewrite of one module. transpileModule is told the file is module.js because a .mjs name
// would keep the module syntax; moduleDetection force treats a file without import or export as a
// module too.
const TRANSPILE_OPTIONS = Object.freeze({
  allowJs: true,
  esModuleInterop: true,
  module: ts.ModuleKind.CommonJS,
  moduleDetection: ts.ModuleDetectionKind.Force,
  newLine: ts.NewLineKind.LineFeed,
  sourceMap: false,
  target: ts.ScriptTarget.ESNext,
});

function toPosix(path) {
  return path.split(sep).join("/");
}

function labelOf(root, path) {
  return toPosix(relative(root, path));
}

function isInside(root, path) {
  const offset = relative(root, path);
  return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

// What labels, file URLs and the outside-root check are relative to: the nearest directory above
// the entry that holds a package.json, or the entry's own directory. No label carries a path of the
// machine that bundled it.
function bundleRoot(entryPath) {
  for (let directory = dirname(entryPath); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory;
    if (dirname(directory) === directory) return dirname(entryPath);
  }
}

function specifierKind(specifier) {
  if (specifier.startsWith("node:")) return "builtin";
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../") ||
    specifier.startsWith("/") || specifier.startsWith("file:")) return "local";
  return "external";
}

function parseModule(name, text) {
  return ts.createSourceFile(name, text, {
    languageVersion: ts.ScriptTarget.ESNext,
    setExternalModuleIndicator: (file) => {
      file.externalModuleIndicator = true;
    },
  }, true, ts.ScriptKind.JS);
}

function stringText(node) {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

function isImportCall(node) {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

// new URL("<string>", import.meta.url): a file the module reads beside itself.
function fileReference(node) {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "URL") return null;
  const [path, base, ...rest] = node.arguments ?? [];
  if (rest.length > 0 || base === undefined || !ts.isPropertyAccessExpression(base) || base.name.text !== "url") return null;
  const meta = base.expression;
  if (!ts.isMetaProperty(meta) || meta.keywordToken !== ts.SyntaxKind.ImportKeyword || meta.name.text !== "meta") return null;
  return stringText(path);
}

function hasTopLevelAwait(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined) ||
      (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function bindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  }
}

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

// The names a module declares at its top level, imports included.
function topLevelNames(sourceFile) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) {
      names.push(statement.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const { name, namedBindings } = statement.importClause;
      if (name !== undefined) names.push(name.text);
      if (namedBindings !== undefined && ts.isNamespaceImport(namedBindings)) names.push(namedBindings.name.text);
      if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) names.push(element.name.text);
      }
    }
  }
  return names;
}

// The names a module exports itself, and the specifiers it passes on with export *.
function ownExports(sourceFile) {
  const names = [];
  const stars = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        const specifier = stringText(statement.moduleSpecifier);
        if (specifier !== null) stars.push(specifier);
      } else if (ts.isNamespaceExport(clause)) {
        names.push(clause.name.text);
      } else {
        for (const element of clause.elements) names.push(element.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      names.push("default");
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        names.push("default");
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) {
        names.push(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
      }
    }
  }
  return { names, stars };
}

function analyze(sourceFile) {
  const statics = [];
  const dynamics = [];
  const fileReferences = [];
  let computedImport = false;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = stringText(statement.moduleSpecifier);
      if (specifier !== null) statics.push(specifier);
    }
  }
  const visit = (node) => {
    if (isImportCall(node)) {
      const specifier = stringText(node.arguments[0]);
      if (specifier === null) computedImport = true;
      else dynamics.push(specifier);
    }
    const reference = fileReference(node);
    if (reference !== null) fileReferences.push(reference);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    statics,
    dynamics,
    fileReferences,
    computedImport,
    topLevelAwait: hasTopLevelAwait(sourceFile),
    exports: ownExports(sourceFile),
    names: topLevelNames(sourceFile),
  };
}

async function resolveModule(root, specifier, from) {
  const details = { specifier, from: from.label };
  let path;
  try {
    const url = new URL(specifier, pathToFileURL(from.path));
    url.search = "";
    url.hash = "";
    path = await realpath(fileURLToPath(url));
  } catch {
    throw new BundleError("BUNDLE_MODULE_NOT_FOUND", `${from.label} imports ${specifier}, which is not a file`, details);
  }
  if (!(await stat(path)).isFile()) {
    throw new BundleError("BUNDLE_MODULE_NOT_FOUND", `${from.label} imports ${specifier}, which is not a file`, details);
  }
  if (!isInside(root, path)) {
    throw new BundleError("BUNDLE_OUTSIDE_ROOT", `${from.label} imports ${specifier}, which lies outside the package the entry belongs to`, details);
  }
  if (!MODULE_EXTENSIONS.has(extname(path))) {
    throw new BundleError("BUNDLE_MODULE_UNSUPPORTED", `${from.label} imports ${specifier}; only .js and .mjs ES modules are bundled`, details);
  }
  return path;
}

// The file a new URL(<reference>, import.meta.url) names, when it exists at bundle time; otherwise
// null, and the reference is left to resolve beside the bundle.
async function carriedFile(root, reference, from) {
  let path;
  try {
    path = await realpath(fileURLToPath(new URL(reference, pathToFileURL(from.path))));
  } catch {
    return null;
  }
  if (!(await stat(path)).isFile()) return null;
  if (!isInside(root, path)) {
    throw new BundleError("BUNDLE_OUTSIDE_ROOT", `${from.label} reads ${reference}, which lies outside the package the entry belongs to`, { specifier: reference, from: from.label });
  }
  return path;
}

// Loads every module the entry reaches and orders them depth first, each after the modules it
// imports: the order ES modules are evaluated in.
async function collect(entryPath, root) {
  const modules = new Map();
  const order = [];
  const visit = async (path) => {
    if (modules.has(path)) return;
    const text = await readFile(path, "utf8");
    const module = { path, label: labelOf(root, path), text, local: new Map(), builtins: new Set(), files: new Map() };
    modules.set(path, module);
    if (text.includes(PREFIX)) {
      throw new BundleError("BUNDLE_NAME_COLLISION", `${module.label} uses ${PREFIX}, which the bundle reserves for its own names`, { module: module.label });
    }
    Object.assign(module, analyze(parseModule(module.label, text)));
    if (module.names.includes("exports")) {
      throw new BundleError("BUNDLE_RESERVED_NAME", `${module.label} declares exports at its top level, the name its exports object has in the bundle`, { module: module.label, name: "exports" });
    }
    for (const specifier of [...module.statics, ...module.dynamics]) {
      const kind = specifierKind(specifier);
      if (kind === "builtin" && isBuiltin(specifier)) {
        module.builtins.add(specifier);
      } else if (kind === "local") {
        if (!module.local.has(specifier)) module.local.set(specifier, await resolveModule(root, specifier, module));
      } else {
        throw new BundleError(
          "BUNDLE_EXTERNAL_DEPENDENCY",
          `${module.label} imports ${specifier}, which is neither a relative module nor a node: built-in; a bundle carries no node_modules`,
          { specifier, from: module.label },
        );
      }
    }
    for (const reference of module.fileReferences) {
      if (module.files.has(reference)) continue;
      const file = await carriedFile(root, reference, module);
      if (file !== null) module.files.set(reference, file);
    }
    for (const specifier of [...module.statics, ...module.dynamics]) {
      const target = module.local.get(specifier);
      if (target !== undefined) await visit(target);
    }
    order.push(module);
  };
  await visit(entryPath);
  return { modules, order };
}

function fileHref(root, path) {
  return new URL(labelOf(root, path).split("/").map(encodeURIComponent).join("/"), `${FILE_SCHEME}///`).href;
}

function fileContent(bytes) {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? ["utf8", text] : ["base64", bytes.toString("base64")];
}

function stripForWrapper(text) {
  // A hashbang is only valid on a file's first line, and a source map comment would name a map
  // the bundle does not carry.
  return text.replace(/^#![^\n]*/u, "").replace(/^\/\/[#@] sourceMappingURL=[^\n]*$/gmu, "");
}

// One module as the body of its function: module syntax becomes exports assignments and require
// calls, each require of a bundled module becomes PREFIXRequire(<number>) and each require of a
// built-in PREFIXBuiltin("node:<name>").
function transformModule(module, ids, fileHrefs) {
  const replaced = new Set();
  const before = (context) => {
    const { factory } = context;
    const visit = (node) => {
      // export {} from "x" and import {} from "x" still evaluate x; the compiler would drop them.
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) && node.exportClause.elements.length === 0) {
        return factory.createImportDeclaration(undefined, undefined, node.moduleSpecifier);
      }
      if (ts.isImportDeclaration(node) && node.importClause !== undefined && node.importClause.name === undefined &&
        node.importClause.namedBindings !== undefined && ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.length === 0) {
        return factory.createImportDeclaration(undefined, undefined, node.moduleSpecifier);
      }
      // An import() the bundler cannot read stays a native import(), relative to the bundle.
      if (isImportCall(node) && stringText(node.arguments[0]) === null) {
        return factory.createCallExpression(factory.createIdentifier(`${PREFIX}Import`), undefined, ts.visitNodes(node.arguments, visit));
      }
      const reference = fileReference(node);
      const file = reference === null ? undefined : module.files.get(reference);
      if (file !== undefined) {
        return factory.updateNewExpression(node, node.expression, node.typeArguments, [factory.createStringLiteral(fileHrefs.get(file))]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (sourceFile) => ts.visitNode(sourceFile, visit);
  };
  const after = (context) => {
    const { factory } = context;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ts.idText(node.expression) === "require" && node.arguments.length === 1) {
        const specifier = stringText(node.arguments[0]);
        const target = specifier === null ? undefined : module.local.get(specifier);
        if (target !== undefined) {
          replaced.add(specifier);
          return factory.createCallExpression(factory.createIdentifier(`${PREFIX}Require`), undefined, [factory.createNumericLiteral(ids.get(target))]);
        }
        if (specifier !== null && module.builtins.has(specifier)) {
          replaced.add(specifier);
          return factory.createCallExpression(factory.createIdentifier(`${PREFIX}Builtin`), undefined, [factory.createStringLiteral(specifier)]);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (sourceFile) => ts.visitNode(sourceFile, visit);
  };
  const result = ts.transpileModule(stripForWrapper(module.text), {
    fileName: "module.js",
    reportDiagnostics: true,
    compilerOptions: TRANSPILE_OPTIONS,
    transformers: { before: [before], after: [after] },
  });
  const error = (result.diagnostics ?? []).find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (error !== undefined) {
    const line = error.file !== undefined && error.start !== undefined ? String(ts.getLineAndCharacterOfPosition(error.file, error.start).line + 1) : "";
    throw new BundleError("BUNDLE_SYNTAX_ERROR", `${module.label}:${line}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`, { module: module.label, line });
  }
  for (const specifier of [...module.statics, ...module.dynamics]) {
    if (!replaced.has(specifier)) throw new Error(`the rewrite of ${module.label} lost its import of ${specifier}`);
  }
  return result.outputText.replace(/\n*$/u, "");
}

// The names the entry exports, export * included; a built-in's are the ones this Node.js has.
function exportNames(module, modules, seen = new Set()) {
  if (seen.has(module)) return [];
  seen.add(module);
  const names = new Set(module.exports.names);
  for (const specifier of module.exports.stars) {
    const target = module.local.get(specifier);
    const passed = target !== undefined
      ? exportNames(modules.get(target), modules, seen)
      : Object.keys(process.getBuiltinModule(specifier) ?? {});
    for (const name of passed) {
      if (name !== "default") names.add(name);
    }
  }
  return [...names];
}

const RUNTIME = `const ${PREFIX}Records = [];
function ${PREFIX}Require(id) {
  let record = ${PREFIX}Records[id];
  if (record === undefined) {
    record = { exports: {}, failed: false, error: undefined };
    ${PREFIX}Records[id] = record;
    try {
      ${PREFIX}Definitions[id].call(undefined, record.exports);
    } catch (error) {
      record.failed = true;
      record.error = error;
      throw error;
    }
  } else if (record.failed) {
    throw record.error;
  }
  return record.exports;
}
const ${PREFIX}Builtins = new Map();
function ${PREFIX}Builtin(specifier) {
  let value = ${PREFIX}Builtins.get(specifier);
  if (value === undefined) {
    value = process.getBuiltinModule(specifier);
    if (value === undefined) {
      throw Object.assign(new Error(\`Cannot find built-in module '\${specifier}'\`), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
    }
    value = ${PREFIX}ServeFiles(specifier, value);
    ${PREFIX}Builtins.set(specifier, value);
  }
  return value;
}`;

const NO_FILES_RUNTIME = `function ${PREFIX}ServeFiles(specifier, value) {
  return value;
}`;

function filesRuntime(entries) {
  return `const ${PREFIX}Files = new Map(${JSON.stringify(entries)});
function ${PREFIX}FileHref(path) {
  const href = path instanceof URL ? path.href : typeof path === "string" ? path : "";
  return href.startsWith(${JSON.stringify(FILE_SCHEME)}) ? href : null;
}
function ${PREFIX}FileBytes(href) {
  const file = ${PREFIX}Files.get(href);
  if (file === undefined) {
    throw Object.assign(new Error(\`ENOENT: no such file or directory, open '\${href}'\`), { errno: -2, code: "ENOENT", syscall: "open", path: href });
  }
  return Buffer.from(file[1], file[0]);
}
function ${PREFIX}FileResult(bytes, options) {
  const encoding = typeof options === "string" ? options : options?.encoding ?? null;
  return encoding === null ? bytes : bytes.toString(encoding);
}
function ${PREFIX}ServeFiles(specifier, target) {
  if (specifier === "node:fs") {
    const readFileSync = (path, ...rest) => {
      const href = ${PREFIX}FileHref(path);
      return href === null ? target.readFileSync(path, ...rest) : ${PREFIX}FileResult(${PREFIX}FileBytes(href), rest[0]);
    };
    const existsSync = (path) => {
      const href = ${PREFIX}FileHref(path);
      return href === null ? target.existsSync(path) : ${PREFIX}Files.has(href);
    };
    return new Proxy(target, {
      get(object, key) {
        if (key === "readFileSync") return readFileSync;
        if (key === "existsSync") return existsSync;
        if (key === "promises") return ${PREFIX}Builtin("node:fs/promises");
        return Reflect.get(object, key);
      },
    });
  }
  if (specifier === "node:fs/promises") {
    const readFile = async (path, ...rest) => {
      const href = ${PREFIX}FileHref(path);
      return href === null ? target.readFile(path, ...rest) : ${PREFIX}FileResult(${PREFIX}FileBytes(href), rest[0]);
    };
    return new Proxy(target, {
      get(object, key) {
        return key === "readFile" ? readFile : Reflect.get(object, key);
      },
    });
  }
  return target;
}`;
}

const IMPORT_RUNTIME = `const ${PREFIX}Import = (specifier, options) => import(specifier, options);`;

function entryRuntime(entryId, entryAsync, names) {
  const lines = entryAsync
    ? [
      `const ${PREFIX}EntryRecord = { exports: {}, failed: false, error: undefined };`,
      `${PREFIX}Records[${entryId}] = ${PREFIX}EntryRecord;`,
      `await ${PREFIX}Definitions[${entryId}].call(undefined, ${PREFIX}EntryRecord.exports);`,
    ]
    : [`${PREFIX}Require(${entryId});`];
  if (names.length > 0) {
    lines.push(`const ${PREFIX}Entry = ${PREFIX}Records[${entryId}].exports;`);
    const bindings = names.map((name, index) => {
      lines.push(`const ${PREFIX}Export${index} = ${PREFIX}Entry[${JSON.stringify(name)}];`);
      return `${PREFIX}Export${index} as ${EXPORT_NAME.test(name) ? name : JSON.stringify(name)}`;
    });
    lines.push(`export { ${bindings.join(", ")} };`);
  }
  return lines.join("\n");
}

/**
 * Bundles the module graph `entry` reaches into one ES module. Returns its text with the labels,
 * relative to the entry's package, of the modules and carried files it holds.
 */
export async function bundleEntry(entry) {
  let entryPath;
  try {
    entryPath = await realpath(entry);
  } catch {
    throw new BundleError("BUNDLE_MODULE_NOT_FOUND", `the entry ${entry} is not a file`, { specifier: String(entry) });
  }
  if (!(await stat(entryPath)).isFile()) {
    throw new BundleError("BUNDLE_MODULE_NOT_FOUND", `the entry ${entry} is not a file`, { specifier: String(entry) });
  }
  if (!MODULE_EXTENSIONS.has(extname(entryPath))) {
    throw new BundleError("BUNDLE_MODULE_UNSUPPORTED", `the entry ${entry} is not a .js or .mjs ES module`, { specifier: String(entry) });
  }
  const root = bundleRoot(entryPath);
  const { modules, order } = await collect(entryPath, root);
  const entryModule = modules.get(entryPath);
  for (const module of order) {
    if (module !== entryModule && module.topLevelAwait) {
      throw new BundleError("BUNDLE_TOP_LEVEL_AWAIT_UNSUPPORTED", `${module.label} awaits at its top level; in a bundle only the entry may`, { module: module.label });
    }
  }
  const ids = new Map(order.map((module, index) => [module.path, index]));
  const carried = [...new Set(order.flatMap((module) => [...module.files.values()]))]
    .sort((left, right) => (labelOf(root, left) < labelOf(root, right) ? -1 : 1));
  const fileHrefs = new Map(carried.map((path) => [path, fileHref(root, path)]));
  const fileEntries = [];
  for (const path of carried) fileEntries.push([fileHrefs.get(path), fileContent(await readFile(path))]);
  const definitions = order.map((module, index) => [
    `// ${index} ${module.label}`,
    `${module === entryModule && module.topLevelAwait ? "async " : ""}function (exports) {`,
    transformModule(module, ids, fileHrefs),
    "},",
  ].join("\n"));
  const hashbang = /^#![^\n]*/u.exec(entryModule.text)?.[0];
  const sections = [
    ...(hashbang === undefined ? [] : [hashbang]),
    `// Bundled by scripts/bundle.mjs from ${entryModule.label} (modules: ${order.length}, carried files: ${carried.length}); only node: built-ins load from outside this file.`,
    RUNTIME,
    carried.length > 0 ? filesRuntime(fileEntries) : NO_FILES_RUNTIME,
    ...(order.some((module) => module.computedImport) ? [IMPORT_RUNTIME] : []),
    `const ${PREFIX}Definitions = [`,
    ...definitions,
    "];",
    entryRuntime(ids.get(entryPath), entryModule.topLevelAwait, exportNames(entryModule, modules).sort()),
  ];
  return {
    code: `${sections.join("\n")}\n`,
    entry: entryModule.label,
    modules: order.map((module) => module.label),
    files: carried.map((path) => labelOf(root, path)),
    // The absolute paths the bundle was built from, modules and carried files; never written into it.
    sources: [...order.map((module) => module.path), ...carried],
  };
}

/** Bundles `entry` and writes the bundle to `out`, creating its directory; never over a source. */
export async function writeBundle(entry, out) {
  const bundle = await bundleEntry(entry);
  const target = await realpath(out).catch(() => out);
  if (bundle.sources.includes(target)) {
    throw new BundleError("BUNDLE_USAGE", `${out} is a file the bundle is built from; write the bundle elsewhere`, { out: String(out) });
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bundle.code);
  if (bundle.code.startsWith("#!")) await chmod(out, 0o755);
  return {
    entry: bundle.entry,
    out,
    modules: bundle.modules.length,
    files: bundle.files.length,
    bytes: Buffer.byteLength(bundle.code),
    sha256: createHash("sha256").update(bundle.code).digest("hex"),
  };
}
