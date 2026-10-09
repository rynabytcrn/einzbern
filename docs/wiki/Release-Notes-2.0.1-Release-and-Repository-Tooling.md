# Einzbern 2.0.1 发行说明：发行与仓库工具

[发行说明](Release-Notes.md) › [Einzbern 2.0.1](Release-Notes-2.0.1.md) › 模块 4/4：发行与仓库工具

上一模块：[迁移](Release-Notes-2.0.1-Migration.md)

## The GitHub Release body is a short description of the version and a link to its Wiki page

The GitHub Release body that `scripts/release.mjs publish-plan` prints and `--execute release`
passes to `gh release create` as `--notes` is a short description of the version and a link to its
page in the Wiki's Release Notes chapter, as the release policy requires (MIN-243 D6), instead of
the version's CHANGELOG section, which for 2.0.0 was longer than GitHub's 125,000-character limit
for a release body (TCRN-CROSS-STORY-520, INIT-053 R50; fixes TCRN-CROSS-STORY-488). The body has
three paragraphs: the first sentence of the release summary, the line
`Release notes, by functional module:` with the address of the Wiki page `Release-Notes-<version>`,
which the script composes from the names module, and the two attachments. When
`docs/wiki/Release-Notes-<version>.md` is missing, empty or not a regular file, the plan refuses
with `RELEASE_WIKI_NOTES_MISSING` before any command is printed or run. The release title, the two
attachments and `docs/releases/<version>.md`, which keeps the CHANGELOG section in full, are
unchanged.

## Links between Wiki pages open the pages

Links between Wiki pages open the pages, and the Atelier page says how to start Atelier
(TCRN-CROSS-STORY-521, INIT-053 R50; fixes TCRN-CROSS-STORY-487). A GitHub Wiki opens a link written
`](Page.md)` as the page's raw Markdown, so `scripts/push-wiki.mjs` now gives the Wiki each Markdown
file with its inline links to the source's top-level pages by page name: `](<page>.md)` and
`](<page>.md#<anchor>)` become `](<page>)` and `](<page>#<anchor>)`. Fenced code blocks, code spans,
images, other links and links to a page the source does not have keep their bytes; `docs/wiki` keeps
its `.md` links for the repository's rendering and the link gate, putting `.md` back gives the
source again, and the receipt counts the rewritten links in `linksRewritten`.

---

[返回模块目录](Release-Notes-2.0.1.md) · 上一模块：[迁移](Release-Notes-2.0.1-Migration.md)
