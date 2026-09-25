// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-466 (MIN-227 D1, D2): the one source of every product, directory and
// schema name the engine uses. World-building names are given to the brand layer and the
// directory layer only, and each of them carries a plain explanation; interfaces stay
// plain. Every old name that code still has to know (to read an old-layout workspace
// read-only, to recognise an old installation, to name a remote that has not been renamed
// yet, to name this machine's checkout folders) comes from this module and nowhere else.

export interface BrandEntry {
  readonly name: string;
  readonly id: string;
  readonly plain: string;
}

export const BRAND = {
  engine: {
    name: "Einzbern",
    id: "einzbern",
    plain: "工作流引擎：把工单、纪要与知识记成带哈希链的事件，读取时校验并重放。",
  },
  helper: {
    name: "Mana Orchestrate",
    id: "mana-orchestrate",
    plain: "给宿主 Agent 用的 Skill 载荷：告诉 Agent 何时、怎样调用 Einzbern。",
  },
  portal: {
    name: "Atelier",
    id: "atelier",
    plain: "本机网页门户：在浏览器里查看库里的工单、纪要与知识。",
  },
  principles: {
    name: "Command Spell",
    id: "command-spell",
    plain: "内置原则集：随引擎提供、可按项目启用的执行规则。",
  },
} as const satisfies Readonly<Record<string, BrandEntry>>;

export const DIRECTORY = {
  library: ".ether",
  events: "akasha",
  knowledge: "crest",
  projectConfig: "config",
  artifacts: "artifacts",
  device: ".einzbern",
  cloudDefaultParent: "Ether",
} as const;

export interface DirectoryGlossaryEntry {
  readonly name: string;
  readonly plain: string;
}

// The plain explanation of each directory name, in the order a reader meets them.
export const DIRECTORY_GLOSSARY: readonly DirectoryGlossaryEntry[] = [
  { name: `${DIRECTORY.library}/`, plain: "库：一个项目的全部记录所在的目录，可以放在项目里，也可以放在云盘里。" },
  { name: `${DIRECTORY.library}/manifest.json`, plain: "库清单：库 id、格式版本、最低引擎版本与项目提示；只在建库、格式变更与迁移时写。" },
  { name: `${DIRECTORY.library}/${DIRECTORY.events}/`, plain: "事件真值：每台设备只追加自己子目录里的事件流，读取时合并全部设备的流。" },
  { name: `${DIRECTORY.library}/${DIRECTORY.knowledge}/`, plain: "知识库：知识卡与文章。" },
  { name: `${DIRECTORY.library}/${DIRECTORY.projectConfig}/`, plain: "项目级配置的投影：随库同步；真值是事件，这里只是便于阅读的副本。" },
  { name: `${DIRECTORY.library}/${DIRECTORY.artifacts}/`, plain: "产物库：按内容哈希存放的大文件。" },
  { name: `~/${DIRECTORY.device}/`, plain: "设备目录：本机的设备身份、库注册表、缓存、备份与已装引擎版本；不随库同步。" },
  { name: `<云盘>/${DIRECTORY.cloudDefaultParent}/<项目名>/`, plain: "库放进云盘时的默认位置。" },
];

export const SCHEMA_NAMESPACE = "einzbern." as const;
export const LEGACY_SCHEMA_NAMESPACE = "tcrn." as const;

// A schemaVersion in the legacy namespace is read-only history: the engine reads and
// replays it byte for byte and never writes a new one.
export function isLegacySchemaVersion(value: string): boolean {
  return value.startsWith(LEGACY_SCHEMA_NAMESPACE);
}

// The old names that code may still need, each for exactly one reason stated beside it.
export const LEGACY_ENGINE_NAME = "tcrn-workflow" as const;
export const LEGACY_HELPER_NAME = "tcrn-workflow-helper" as const;
// The old in-workspace control directory (`<workspace>/.tcrn-workflow/`): read-only.
export const LEGACY_CONTROL_DIRECTORY = ".tcrn-workflow" as const;
// The old per-machine directory (`~/.tcrn-workflow`): recognised to find an old install.
export const LEGACY_DEVICE_DIRECTORY = ".tcrn-workflow" as const;
export const LEGACY_CONTAINER_DIRECTORY = ".tcrn-workspace" as const;
export const LEGACY_PORTAL_NAME = "TCRN Workflow Portal" as const;
export const LEGACY_EVENTS_DIRECTORY = "events" as const;
export const LEGACY_KNOWLEDGE_DIRECTORY = "knowledge" as const;
export const PLATFORM_ARCHIVE_DIRECTORY = ".tcrn-artifacts" as const;

export interface LegacyNameEntry {
  readonly legacy: string;
  // null: the old name does not move (it keeps its name and is not migrated).
  readonly current: string | null;
  readonly note: string;
}

export const LEGACY_NAMES: readonly LegacyNameEntry[] = [
  { legacy: LEGACY_ENGINE_NAME, current: BRAND.engine.id, note: "引擎：仓名、npm 包名与 CLI 命令名" },
  { legacy: LEGACY_HELPER_NAME, current: BRAND.helper.id, note: "助手：仓名与 Skill id" },
  { legacy: LEGACY_CONTAINER_DIRECTORY, current: DIRECTORY.library, note: "项目生成物目录（库）" },
  { legacy: `${LEGACY_CONTROL_DIRECTORY}/`, current: `${DIRECTORY.library}/`, note: "旧布局的工作区控制目录；新引擎只读打开，不再写入" },
  { legacy: `${LEGACY_EVENTS_DIRECTORY}/`, current: `${DIRECTORY.events}/`, note: "事件目录；新布局每台设备一个子目录" },
  { legacy: `${LEGACY_KNOWLEDGE_DIRECTORY}/`, current: `${DIRECTORY.knowledge}/`, note: "知识目录" },
  { legacy: `~/${LEGACY_DEVICE_DIRECTORY}`, current: `~/${DIRECTORY.device}`, note: "设备目录（本机）" },
  { legacy: LEGACY_PORTAL_NAME, current: BRAND.portal.name, note: "门户" },
  { legacy: `${LEGACY_SCHEMA_NAMESPACE}*`, current: `${SCHEMA_NAMESPACE}*`, note: "schema 命名空间；已写入的 tcrn.* 原样保留为只读旧命名空间，新写入用 einzbern.*" },
  { legacy: PLATFORM_ARCHIVE_DIRECTORY, current: null, note: "平台档案，归平台层，不随改名迁移" },
];

// This machine's checkout folders. They keep their names (the dispatch that renamed the
// products did not rename local folders); code that recognises a sibling checkout by its
// folder name reads it from here.
export const LOCAL_DIRECTORY_NAMES = {
  classificationFolder: "TCRN Platform",
  engine: `TCRN Platform/${LEGACY_ENGINE_NAME}`,
  helper: `TCRN Platform/${LEGACY_HELPER_NAME}`,
} as const;

// The GitHub remotes as they are named until the Owner renames them (a separate stop).
export const LEGACY_REPOSITORY_NAMES = {
  owner: "tpmoonchefryan",
  engine: LEGACY_ENGINE_NAME,
  helper: LEGACY_HELPER_NAME,
} as const;

export const ALIAS_TABLE_START_MARKER = "<!-- einzbern:alias-table:start -->" as const;
export const ALIAS_TABLE_END_MARKER = "<!-- einzbern:alias-table:end -->" as const;

function aliasCell(value: string | null): string {
  return value === null ? "（不改名、不迁移）" : `\`${value}\``;
}

// The alias table as Markdown lines, header first. CHANGELOG.md, docs/wiki/Glossary.md
// and every new library's README.md carry exactly these lines between the two markers.
export function renderLegacyAliasTable(): readonly string[] {
  return [
    "| 旧名 | 新名 | 说明 |",
    "| --- | --- | --- |",
    ...LEGACY_NAMES.map((entry) => `| ${aliasCell(entry.legacy)} | ${aliasCell(entry.current)} | ${entry.note} |`),
  ];
}

// The legacy engine entry point inside an old installation, spelled from the aliases so
// no caller has to keep the literal.
export function legacyInstalledEnginePath(home: string): string {
  return `${home}/${LEGACY_DEVICE_DIRECTORY}/${LEGACY_ENGINE_NAME}/scripts/${LEGACY_ENGINE_NAME}.mjs`;
}
