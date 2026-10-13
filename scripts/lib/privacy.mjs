// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { compareCanonicalText } from "./canonical-order.mjs";
import { PRIVATE_TOKEN_NAMES } from "./private-token-roster.mjs";
import { TAR_BLOCK_BYTES, readUstar } from "./tar.mjs";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const joinParts = (parts, separator) => parts.join(separator);

export function decodeGitMetadataBytes(content, reasonCode) {
  if (!Buffer.isBuffer(content) || typeof reasonCode !== "string" || reasonCode.length === 0) {
    throw new Error("GIT_METADATA_DECODE_INPUT_INVALID");
  }
  try {
    return strictUtf8.decode(content);
  } catch {
    throw new Error(reasonCode);
  }
}

export function decodePrivacyScanBytes(content) {
  if (!Buffer.isBuffer(content)) throw new Error("PRIVACY_SCAN_BYTES_REQUIRED");
  // Privacy patterns are textual and continue to scan the UTF-8 projection,
  // while byte-count and digest evidence retain the original Buffer below.
  return content.toString("utf8");
}

export function aggregatePrivacySurface(records) {
  const ordered = [...records].sort((left, right) => compareCanonicalText(left.path, right.path));
  const digest = createHash("sha256");
  let bytes = 0;
  for (const record of ordered) {
    const content = Buffer.isBuffer(record.content) ? record.content : Buffer.from(record.content, "utf8");
    bytes += content.length;
    digest.update(record.path, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(content.length), "utf8");
    digest.update("\0", "utf8");
    digest.update(content);
  }
  return { entries: ordered.length, bytes, sha256: digest.digest("hex") };
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// MIN-235 D6: hash-only rules for individually reviewed public metadata and manual test samples.
// Both the matched text and its full normalized line must match; unknown values, changed lines,
// and other paths remain findings. The P8 build projection has its own path and line digest.
// Digests keep sample正文 out of code and reports.
const CLASSIFIED_PRIVACY_MATCHES = new Set([
  "docs/verification/init053-owner-return-component-inventory.json\u0000OWNER_PRIVATE_IDENTIFIER\u00001b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f\u0000ea08e88222217b0cda6d5021955e9b41313993ca6fe8a768a074bd01a1881ab6",
  "docs/verification/init053-owner-return-copy-inventory.json\u0000OWNER_PRIVATE_IDENTIFIER\u00001b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f\u0000ea08e88222217b0cda6d5021955e9b41313993ca6fe8a768a074bd01a1881ab6",
  "docs/verification/init053-owner-return-limit-inventory.json\u0000OWNER_PRIVATE_IDENTIFIER\u00001b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f\u0000ea08e88222217b0cda6d5021955e9b41313993ca6fe8a768a074bd01a1881ab6",
  "docs/verification/init053-owner-return-scope-inventory.json\u0000OWNER_PRIVATE_IDENTIFIER\u00001b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f\u0000ea08e88222217b0cda6d5021955e9b41313993ca6fe8a768a074bd01a1881ab6",
  "packages/core/src/names.ts\u0000OWNER_PRIVATE_IDENTIFIER\u00001b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f\u0000acbbf0306043799672e383fe5bdfc98bfe0a2b1675085c911fce83869dc4a4be",
  "dist/build/packages/core/src/names.js\u0000OWNER_PRIVATE_IDENTIFIER\u00001b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f\u00003861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56",
  "tests/agents-sections.test.mjs\u0000EMAIL_IDENTIFIER\u0000732c098147f75109ac67eec4b33383fe9495028b44dd9b5c69540f080fa7efd8\u0000ef939f026250ca3b0dbf0951c7928e94cda9948a533bbc7c62d9938429cb85d1",
  "tests/agents-sections.test.mjs\u0000EMAIL_IDENTIFIER\u0000740ad4796e4e6c6060892b0c6776b532663dbf1ad24d624c30539ad9a2242a1d\u00001d61adc8379f3685b9f7e2b47fa9e833b03402b68459b4c142f774a2358a5d89",
  "tests/agents-sections.test.mjs\u0000EMAIL_IDENTIFIER\u0000740ad4796e4e6c6060892b0c6776b532663dbf1ad24d624c30539ad9a2242a1d\u00002f483715784d5afb94936391f64c9d70b217c0385cc84e98c038e72dbe7e820e",
  "tests/agents-sections.test.mjs\u0000EMAIL_IDENTIFIER\u0000740ad4796e4e6c6060892b0c6776b532663dbf1ad24d624c30539ad9a2242a1d\u0000f0805cb68cdc61469a0b4453288f6068ba7af8051ae68308bdeadfff20864076",
  "tests/cloud-roots.test.mjs\u0000EMAIL_IDENTIFIER\u0000bc2f60d2e7b8555806e04afa4091a614f5d0650f0d8a809a4f9a10476c864c42\u0000b7e4cf676ce6938f8c77e773935d01ba5b2136b2756362fe63b21ddd904fd8bf",
  "tests/cloud-roots.test.mjs\u0000LINUX_HOME_PATH\u00005d1bf737f3d16abdd308d0c68b33a83d6119bce7b2d196439a2a78c62da0e5b6\u000050f3803332b6dda8f0418a5684ff9d9fab32027490f230c6360d30d7f912c34a",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u000004c7156bfebee48e0a74f42b67c2c61a94c1fc0f9295c2aca37575cd2ef6fc90",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u000052f8405611ee39dbe54097caaa2f1da42d2d0d9a549e47e5ab29b49f35ad2f21",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u00005b33f3c75a858cd605d1626cfb27e6f6e629f43e461bdcf7f4b4bad7ee106c25",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u0000607e7d272f5f9d87918d90cf1baf81bcd23475c1f6dd0af9926d39a66568d234",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u00007f38ed0c7de84daf5deed359a017cba142a6d62f0951e89b29ebc911686a324c",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u000086b7c08b8a5b5df9bc6150d335af0ac52a068f8c31d37a5424953cd9613cf308",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u00008832abeb464b52c9888254814846d912276261d8c75cca305f7685f3ad542604",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u0000b7e4cf676ce6938f8c77e773935d01ba5b2136b2756362fe63b21ddd904fd8bf",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00002284482be1cfd3e1432e6aad418a654fba6eb59866520ef14d30572661e5e2ae\u0000cd9925ae2a5c86ab91d09d2d58b6e5f75d3ee2261995979e096bbfa69355aece",
  "tests/cloud-roots.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u00009ed5c01c23acc6ce608ce47f914e13c2a3a5a4c9c959c1baf67f06b2b2f60756\u000052f8405611ee39dbe54097caaa2f1da42d2d0d9a549e47e5ab29b49f35ad2f21",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000390150488f06f28c47cd6c51a94da8a81bfa5cc8019f1f1884ea7897bbfbe95b",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u00008c8c1d049b55cc70f46780d1449065dc8c2d332a306c928829b681fea290cc47",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000a6ec4a0bd26486f3ee4eab7ca8b83ea1bc00a0c44462699a326ab4033cddf038",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000aed6e1f5fe7dedd7cd4e3ef51f31a08397a3a3c557b6ad1d7010302680aaf1fe",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000b2cb61709c04038c8b2b42da8f7a9ef30a5d709db8b051fc5bf199b9651c35a6",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000bc0e429f554acf140b5fcf539afdc39834cf854097068b6ec8eb4b0b37ee9123",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000eb689c00d1b64d0647c241f6542fe02c0e0f49f85d872aa0234446fa9b27ed76",
  "tests/cloud-roots.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u0000eca03ee52df2fd81a781f8a7d044fcaa57e119decb0a69edc12b446235a52b87",
  "tests/p1-all-legs.test.mjs\u0000EMAIL_IDENTIFIER\u0000cc6d96611cffa9f02c3626f0b9ee897dc171e2d540a5cae349d4ec316104997b\u00009abe66319db9dec4df7e3e269f03d416653b8291e4dfc9817e019e8713af9fba",
  "tests/p1-all-legs.test.mjs\u0000EMAIL_IDENTIFIER\u0000cc6d96611cffa9f02c3626f0b9ee897dc171e2d540a5cae349d4ec316104997b\u000015098a3244e66f11cda7f373d078df8420d67fc345403291e0e51f24ed1f456f",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u00000bb6f8ae650d1259bed27a6044ebaadfd6c9fceb40245f9bd9566bd4dbfc3ed9",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u000039c789e4a03f687e901326d1016037713b1e2325518be4547c66fa19a8a3dc70",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u0000570457b113cf34586fa686091c0ef935b736fedf49e021f839746764ecde7649",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u00008608880edaabeb015456db7b3ceb9c6fcad4e7e1e569d130164ef0e6e8bd763e",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u0000beb4effc77d647337f52d6158e82166606ee07606058e6591601e4fa45ee4abf",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u0000deca1173558847313cca09c962f689b4e2af7ec8db5510a67d234ce1b2858970",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u0000f101ee68b73507966fe6914b52e8b1adbc1760820ee613ceaf94ab578b42fc13",
  "tests/privacy-boundary.test.mjs\u0000CUSTOMER_SOURCE_MARKER\u00007ab496d61c555b4eb7809cd416c7a07fccc4afe995c041bf3a2347affa3a22ea\u0000fba656531fc518a16aa604b89079899aa113bd75cb6b6d479066efd5752f76c7",
  "tests/privacy-boundary.test.mjs\u0000LOCAL_ABSOLUTE_PATH\u0000f5e4c2aea38c42f32e930c142639e2eadd105dfacf02e751d035fad6ff1b984a\u0000c3574365dbfbeb8b069b6815c9f062cffc7fcb2b7601397068ed5f93a4e1567b",
  "tests/privacy-boundary.test.mjs\u0000PRIVATE_HOSTNAME\u0000e2402e844e5bdc4aad6390029485ba98222703f7d35813a629726fc97d5d7aff\u00003c74b04fd50c11ec6e00cba5da96f2df9157770cb5d7648f6d8b017bbaefbfd8",
  "tests/privacy-boundary.test.mjs\u0000PRIVATE_HOSTNAME\u0000e2402e844e5bdc4aad6390029485ba98222703f7d35813a629726fc97d5d7aff\u0000d8d4ff841ea7863775bdf39c881db922d950f4fa325f93dcd75fd6c3f9f22568",
  "tests/privacy-boundary.test.mjs\u0000PRIVATE_SSH_URL\u00000bdddfe24b8f9a16e6704fd7725c1fc2a93b0d34b761b3db57f1d9f3be2e5699\u00003c74b04fd50c11ec6e00cba5da96f2df9157770cb5d7648f6d8b017bbaefbfd8",
  "tests/privacy-boundary.test.mjs\u0000PRIVATE_SSH_URL\u00000bdddfe24b8f9a16e6704fd7725c1fc2a93b0d34b761b3db57f1d9f3be2e5699\u0000d8d4ff841ea7863775bdf39c881db922d950f4fa325f93dcd75fd6c3f9f22568",
  "tests/privacy-boundary.test.mjs\u0000WINDOWS_USER_PATH\u0000309e5fa0afe8051d225a3d1a6dafe7b2d65d23b6d224cc39077ce5090efdfecd\u00000d6459ee2e8c78688741d64ffb9f209303dce1d799089de7644184605698a7d4",
  "tests/push-wiki.test.mjs\u0000EMAIL_IDENTIFIER\u0000234fa22132f49355b994008468e4d0fcb9eb9afcda4455c8fb86a668b8955332\u0000eed76a14a72a32588bf324a736cee420a33438354875cebea5e6ac6bd49f40bb",
  "tests/registry-resolve.test.mjs\u0000EMAIL_IDENTIFIER\u0000f55654d4fa1594e4dc4c831f3634ca91f5d9e00c3b7e51f6f092c8a6c6a6ca77\u0000f8f672b13fdc19bdb2bd6c10d3626f1cb21d69af146f7096047ae868b1bf0be3",
  "tests/release-lockstep.test.mjs\u0000EMAIL_IDENTIFIER\u0000c4e15b25a1b3499cb3b1aab100a19d1042c96e10e59ab0835ae208d60ab7d7a6\u000041fdd1befbe3d94e088ac111e3209803f94fd1e97e27960af8259cc548cc689b",
  "tests/setup-fresh.test.mjs\u0000EMAIL_IDENTIFIER\u0000d525ba4089c339942bd5a42b69c3613d313cb77841a6bb197f23f6dd1fd913aa\u00001c4586aaa5ba8e71329f3e95ee8eb59292e8026ce346f4edf6849117fffab7c2",
  "tests/variables-cli.test.mjs\u0000AWS_ACCESS_KEY\u00001a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3\u0000f991ae3f654d9d6873a23aed1046e8870c255cfe991d0b465adebd8fe1bde9ad",
  "tests/variables-cli.test.mjs\u0000GITHUB_CLASSIC_TOKEN\u0000dec6a48dd5610e7f4a00f2e4d35d2dfb29a720b9cb491360d9a137e366a3adae\u00004fb20e2489318568c1801627944eec2f6f9157c32998b210ffcd1b0f9dcef2a3",
  "tests/variables.test.mjs\u0000AWS_ACCESS_KEY\u00001a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3\u00001e70e593710103d2d171f785d43cd22ca05fa1651c77beb1726df05393c229c8",
  "tests/variables.test.mjs\u0000AWS_ACCESS_KEY\u0000e1de2469408636f0ce20ad2b1b33e1be3f903261377ea0189615b936fe397df6\u00006b0d695a5c64e946b939171dc5455a23196142e66429dfb18914d53790824974",
  "tests/variables.test.mjs\u0000GITHUB_CLASSIC_TOKEN\u00003543c50b0cb9cea8e55eb1f529b79f043cb250d485fde7b66cabbb5183add7da\u000020bf79aab432fdf2f8a921eef3284130c515208a98a09bff8a1381c980e1f1c5",
  "tests/variables.test.mjs\u0000GITHUB_CLASSIC_TOKEN\u0000bc3ae723f57c6b9e3fd80b699fcc420f6074b0b1718039669d22631d508ac0a7\u000017c8bf163b2c2af9146c993d48f738bfba9c3244b9fd6d385d197689c8b0975f",
  "tests/variables.test.mjs\u0000GITHUB_CLASSIC_TOKEN\u0000dec6a48dd5610e7f4a00f2e4d35d2dfb29a720b9cb491360d9a137e366a3adae\u0000ceaa7e71f920b390511956dc7523cf98b26ac76e367c8da7fceb0e42283a7dcf",
  "tests/variables.test.mjs\u0000PRIVATE_KEY\u00003021d90eb9437b2d8f30e8363695c4418b5e5f1870801b5c317e9398ee0f572d\u000056fdf99f9a1bb9c9d439ab956e301ffaea7cc41388f4639f76aa21dc39c5b496",
  "tests/variables.test.mjs\u0000PRIVATE_KEY\u00008bcac7908eb950419537b91e19adc83ce2c9cbfdacf4f81157fdadfec11f7017\u0000a77bca7ce9555b3bde511730134d511cf811229f140f55f40747e1b85462c217",
]);

// R12: these three P8 tar members are the only packaged copies of the reviewed
// public owner metadata line. The exact member label and build origin are part
// of the rule; changing the archive, version, member path, origin, value, or line
// falls back to a finding. The line and value digests were verified against the
// tracked names.ts object and its compiled output before adding these entries.
// TCRN-CROSS-SUB-357 S1 (INIT-053 R41 B2): the 2.0.0 package was reviewed member by member
// from an isolated end-to-end release dry run. Exactly the same three members carry the same
// compiled owner line, each once, and get their own exact labels; no other member or artifact
// is classified, and no version is matched by pattern.
// TCRN-CROSS-INIT-053 U23 P-F: the 2.0.1 package was reviewed the same way, from an isolated
// end-to-end release dry run. The same three members carry the same compiled owner line once
// each and get their own exact labels; the one other owner occurrence, in scripts/einzbern.mjs,
// is the complete public helper repository address and is no finding.
// TCRN-CROSS-INIT-053 R54 PF: the 2.0.2 package was reviewed the same way, from an isolated
// end-to-end release dry run at the 2.0.2 release base. The same three members carry the same
// compiled owner line once each and get their own exact labels; the other owner occurrence, in
// scripts/einzbern.mjs, is again the complete public helper repository address and is no finding.
// TCRN-CROSS-EPIC-149 R2 PF: the 2.0.3 package was reviewed the same way, from an isolated
// end-to-end release dry run at the 2.0.3 release base. The same three members carry the same
// compiled owner line once each and get their own exact labels; the other owner occurrence, in
// scripts/einzbern.mjs, is again the complete public helper repository address and is no finding.
const CLASSIFIED_P8_RELEASE_ENTRY_SOURCES = new Map([
  ["dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/atelier/portal.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/scripts/einzbern-hook.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/scripts/einzbern.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.0.tar.gz/einzbern-2.0.0/atelier/portal.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.0.tar.gz/einzbern-2.0.0/scripts/einzbern-hook.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.0.tar.gz/einzbern-2.0.0/scripts/einzbern.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.1.tar.gz/einzbern-2.0.1/atelier/portal.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.1.tar.gz/einzbern-2.0.1/scripts/einzbern-hook.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.1.tar.gz/einzbern-2.0.1/scripts/einzbern.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.2.tar.gz/einzbern-2.0.2/atelier/portal.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.2.tar.gz/einzbern-2.0.2/scripts/einzbern-hook.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.2.tar.gz/einzbern-2.0.2/scripts/einzbern.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.3.tar.gz/einzbern-2.0.3/atelier/portal.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.3.tar.gz/einzbern-2.0.3/scripts/einzbern-hook.mjs", "dist/build/packages/core/src/names.js"],
  ["dist/release/einzbern-2.0.3.tar.gz/einzbern-2.0.3/scripts/einzbern.mjs", "dist/build/packages/core/src/names.js"],
]);
const CLASSIFIED_P8_RELEASE_MATCHES = new Set(
  [...CLASSIFIED_P8_RELEASE_ENTRY_SOURCES.entries()].map(([label, sourcePath]) => [
    label,
    sourcePath,
    "OWNER_PRIVATE_IDENTIFIER",
    "1b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f",
    "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56",
  ].join("\0")),
);

export function p8ReleasePrivacySourcePaths(label) {
  const sourcePath = CLASSIFIED_P8_RELEASE_ENTRY_SOURCES.get(label);
  return sourcePath === undefined ? [] : [sourcePath];
}

// MIN-238 D4 (TCRN-CROSS-STORY-488): the engine and helper repositories keep the existing
// account, so their final addresses carry the owner name. Under MIN-235 D6 exactly these two
// (owner, repository) tuples are public metadata. The owner is the reviewed names.ts value,
// pinned by its digest. An address counts only as the complete literal `<owner>/<repository>`
// or `https://github.com/<owner>/<repository>` in file, object or package content. These stay
// OWNER_PRIVATE_IDENTIFIER findings: the owner name on its own, another owner or repository,
// an address that continues into a longer name, path or URL, and a file or member path. The
// rule applies to each occurrence; no line or file is exempt.
const REVIEWED_OWNER_DIGEST = "1b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f";
const PUBLIC_REPOSITORY_ADDRESSES = Object.freeze([
  Object.freeze({ ownerDigest: REVIEWED_OWNER_DIGEST, repository: "einzbern" }),
  Object.freeze({ ownerDigest: REVIEWED_OWNER_DIGEST, repository: "mana-orchestrate" }),
]);
const PUBLIC_REPOSITORY_URL_PREFIX = "https://github.com/";
const PUBLIC_REPOSITORY_ADDRESS_KINDS = new Set(["source", "blob", "build", "archive", "release", "commit", "tag"]);
// A neighbouring character from these sets would make the address part of a longer account,
// repository, path, URL, host or mail address. A backslash may follow the address (the escaped
// closing backtick of a template literal) but may not precede it (a Windows path).
const ADDRESS_CONTINUES_BEFORE = /[A-Za-z0-9._~%+@:$\/\\-]/u;
const ADDRESS_CONTINUES_AFTER = /[A-Za-z0-9._~%+@:$\/#?-]/u;

function privacyDigest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lineAt(value, offset) {
  const start = value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = value.indexOf("\n", offset);
  return value.slice(start, end === -1 ? value.length : end);
}

function classifiedOrigins(entry) {
  if (entry.kind === "source" || entry.kind === "build") return [entry.label];
  if (!Array.isArray(entry.sourcePaths)) return [];
  return [...new Set(entry.sourcePaths)];
}

function isPublicRepositoryAddress(entry, reasonCode, input, match) {
  if (reasonCode !== "OWNER_PRIVATE_IDENTIFIER" || !PUBLIC_REPOSITORY_ADDRESS_KINDS.has(entry.kind)) return false;
  // Archive headers carry member paths; a path that names the owner is not an address.
  if (entry.label.includes("#header:")) return false;
  const ownerDigest = privacyDigest(match[0]);
  const ownerEnd = match.index + match[0].length;
  const prefixStart = match.index - PUBLIC_REPOSITORY_URL_PREFIX.length;
  const addressStart = prefixStart >= 0 && input.startsWith(PUBLIC_REPOSITORY_URL_PREFIX, prefixStart) ? prefixStart : match.index;
  if (addressStart > 0 && ADDRESS_CONTINUES_BEFORE.test(input[addressStart - 1])) return false;
  return PUBLIC_REPOSITORY_ADDRESSES.some((address) => {
    const path = `/${address.repository}`;
    if (address.ownerDigest !== ownerDigest || !input.startsWith(path, ownerEnd)) return false;
    const end = ownerEnd + path.length;
    return end === input.length || !ADDRESS_CONTINUES_AFTER.test(input[end]);
  });
}

function hasUnclassifiedPrivacyMatch(entry, reasonCode, pattern, inputs) {
  const origins = classifiedOrigins(entry);
  const isClassified = (origin, digest, lineDigest) => {
    if (entry.kind === "release") {
      if (entry.releaseArchiveMember === true) {
        return CLASSIFIED_P8_RELEASE_MATCHES.has([entry.label, origin, reasonCode, digest, lineDigest].join("\0"));
      }
      // Source tar members carry their original tracked path on `#body:` labels;
      // other release entries need the exact P8 package rule above.
      if (!entry.label.includes("#body:")) return false;
    }
    return CLASSIFIED_PRIVACY_MATCHES.has([origin, reasonCode, digest, lineDigest].join("\0"));
  };
  for (const input of inputs) {
    pattern.lastIndex = 0;
    if (!pattern.test(input)) continue;
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (const match of input.matchAll(matcher)) {
      if (isPublicRepositoryAddress(entry, reasonCode, input, match)) continue;
      const digest = privacyDigest(match[0]);
      const lineDigest = privacyDigest(lineAt(input, match.index));
      if (origins.length === 0 || origins.some((origin) => !isClassified(origin, digest, lineDigest))) {
        return true;
      }
    }
  }
  return false;
}

function tarHeaderText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function tarHeaderSize(header) {
  const text = tarHeaderText(header, 124, 12).trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error("PRIVACY_ARCHIVE_LAYOUT_INVALID");
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("PRIVACY_ARCHIVE_LAYOUT_INVALID");
  return size;
}

function isSourceArchiveEntry(entry) {
  return (entry.kind === "archive" && entry.label === "dist/source/einzbern-source.tar") ||
    (entry.kind === "release" && /^dist\/release\/[^/]+-source\.tar$/u.test(entry.label));
}

function expandSourceArchiveEntry(entry) {
  const bytes = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
  const files = readUstar(bytes);
  const expanded = [];
  let offset = 0;
  let fileIndex = 0;
  while (offset + TAR_BLOCK_BYTES <= bytes.length && !bytes.subarray(offset, offset + TAR_BLOCK_BYTES).every((byte) => byte === 0)) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && type !== "\0") throw new Error("PRIVACY_ARCHIVE_LAYOUT_INVALID");
    const file = files[fileIndex++];
    const path = tarHeaderText(header, 0, 100);
    const prefix = tarHeaderText(header, 345, 155);
    const joinedPath = prefix === "" ? path : `${prefix}/${path}`;
    const size = tarHeaderSize(header);
    if (file === undefined || file.path !== joinedPath || file.bytes.length !== size) {
      throw new Error("PRIVACY_ARCHIVE_LAYOUT_INVALID");
    }
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (paddedEnd > bytes.length) throw new Error("PRIVACY_ARCHIVE_LAYOUT_INVALID");
    expanded.push({ label: `${entry.label}#header:${joinedPath}`, kind: entry.kind, content: header.toString("utf8") });
    expanded.push({ label: `${entry.label}#body:${joinedPath}`, kind: entry.kind, sourcePaths: [joinedPath], content: decodePrivacyScanBytes(file.bytes) });
    const padding = bytes.subarray(dataEnd, paddedEnd);
    if (padding.length > 0) expanded.push({ label: `${entry.label}#padding:${joinedPath}`, kind: entry.kind, content: padding.toString("utf8") });
    offset = paddedEnd;
  }
  if (fileIndex !== files.length) throw new Error("PRIVACY_ARCHIVE_LAYOUT_INVALID");
  const trailer = bytes.subarray(offset);
  if (trailer.length > 0) expanded.push({ label: `${entry.label}#trailer`, kind: entry.kind, content: trailer.toString("utf8") });
  return expanded;
}

function privacyPatterns(owner, privateTokens = []) {
  const legacyName = joinParts(["TCRN", "Workflow", "Platform", "Legacy"], "-");
  const controlDirectory = joinParts([".", "context", "/"], "");
  const agentDirectory = joinParts([".", "llm", "/"], "");
  const localUserPath = joinParts(["/", "Users", "/[^/\\s]+/"], "");
  const linuxHomePath = joinParts(["/", "home", "/[^/\\s]+/"], "");
  const sshUrlPrefix = joinParts(["ssh", ":", "/", "/"], "");
  const patterns = [
    ["LOCAL_ABSOLUTE_PATH", new RegExp(localUserPath, "u")],
    ["LINUX_HOME_PATH", new RegExp(linuxHomePath, "u")],
    ["WINDOWS_USER_PATH", /[A-Za-z]:\\+Users\\+/u],
    ["THREAD_IDENTIFIER", /019[a-f0-9]{5}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/u],
    ["EMAIL_IDENTIFIER", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u],
    ["GITHUB_CLASSIC_TOKEN", /gh[pousr]_[A-Za-z0-9_]{20,}/u],
    ["GITHUB_FINE_GRAINED_TOKEN", /github_pat_[A-Za-z0-9_]{20,}/u],
    ["AWS_ACCESS_KEY", /(?:AKIA|ASIA)[0-9A-Z]{16}/u],
    ["NPM_TOKEN", /npm_[A-Za-z0-9]{36,}/u],
    ["SLACK_TOKEN", /xox[baprs]-[A-Za-z0-9-]{20,}/u],
    ["GOOGLE_API_KEY", /AIza[0-9A-Za-z_-]{35}/u],
    ["AZURE_STORAGE_KEY", /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/u],
    ["JWT_TOKEN", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u],
    // Credentials are private regardless of the URL scheme. The old https?
    // shape missed postgres:// and other service connection strings.
    ["AUTHENTICATED_URL", /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu],
    ["PRIVATE_HOSTNAME", /\b[A-Za-z0-9-]+\.(?:lan|internal|corp)\b/iu],
    ["PRIVATE_USER_AT_HOST", /\b(?:deploy|root|tcrn|ubuntu)@[A-Za-z0-9.-]+\b/iu],
      // Loopback is deliberately NOT in this class. The class exists to catch an
      // address that reveals someone's network — which host, which subnet, what the
      // deployment looks like. 127.0.0.1 names no host and is identical on every
      // machine on earth; publishing it discloses nothing. Keeping it here made any
      // feature that binds locally unreleasable, which is how the portal's bind
      // address — a security property meant to be stated out loud — tripped a
      // privacy gate. The RFC 1918 ranges are unchanged.
    ["PRIVATE_IPV4", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/u],
    ["US_SSN", /\b\d{3}-\d{2}-\d{4}\b/u],
    ["PHONE_IDENTIFIER", /\+?\d{1,3}[-. ]\d{3}[-. ]\d{3}[-. ]\d{4}\b/u],
    ["CUSTOMER_SOURCE_MARKER", /\b(?:customer|tenant)[-_ ](?:export|dump|backup)\b/iu],
    ["CONTROL_PLANE_PATH", new RegExp(controlDirectory.replace(".", "\\."), "u")],
    ["AGENT_CONTROL_PATH", new RegExp(agentDirectory.replace(".", "\\."), "u")],
    ["LEGACY_REMOTE_NAME", new RegExp(legacyName, "u")],
    ["PRIVATE_RUNTIME_PATH", /\/(?:srv|var)\/[A-Za-z0-9._-]+\/(?:governance|engine)(?:\/|\b)/u],
    ["PRIVATE_SSH_URL", new RegExp(escaped(sshUrlPrefix), "u")],
    ["OWNER_PRIVATE_IDENTIFIER", new RegExp(escaped(owner), "u")],
  ];
  for (const token of privateTokens) {
    if (typeof token !== "string" || token.length === 0) continue;
    patterns.push(["PRIVATE_RUNTIME_VALUE", new RegExp(escaped(token), "u")]);
  }
  // A private value hidden behind a constructor is still a private value. This
  // structural leg is deliberately conservative: it only fires when an encoder
  // is close to a deployment-private token name, so ordinary String.fromCharCode
  // fixtures elsewhere in the repository remain valid.
  const privateName = [...PRIVATE_TOKEN_NAMES, "PRIVATE_VM_HOST", "PRIVATE_RUNTIME_ROOT", "PRIVATE_FACADE_IP", "GOVERNANCE_ROOT"]
    .map(escaped)
    .join("|");
  patterns.push([
    "OBFUSCATED_PRIVATE_CONFIGURATION",
    new RegExp(`(?:^\\s*(?:const|let|var)\\s+(?:${privateName})[^\\n]*(?:\\.join\\s*\\(|String\\.fromCharCode|fromCharCode|atob\\s*\\(|base64|\\.reverse\\s*\\())|(?:^\\s*["']?pattern["']?\\s*:[^\\n]*(?:\\\\x[0-9a-f]{2}|\\\\u[0-9a-f]{4}|\\.join\\s*\\(|String\\.fromCharCode|atob\\s*\\(|base64|\\.reverse\\s*\\())`, "mu"),
  ]);
  return patterns;
}

function decodeJavascriptString(value) {
  try {
    return JSON.parse(`"${value.replaceAll('"', '\\"')}"`);
  } catch {
    return value
      .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\u\{([0-9a-f]+)\}/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\\//gu, "/");
  }
}

function evaluateStringLiteral(value) {
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") return null;
  const body = value.slice(1, -1);
  return quote === "\"" ? decodeJavascriptString(body) : body
    .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll(/\\\//gu, "/")
    .replaceAll("\\'", "'");
}

// A privacy scan must distinguish a path that appears in program data from the
// syntax of a regular-expression literal. Decoding every `\\/` in a source
// file turns a pattern containing an escaped local prefix and a character class into a convincing-looking
// path and lets its character class provide a fake username. Keep this lexer
// small and non-executing: it recognizes strings, comments and regex literals,
// then projects only literal portions of a valid regex into the normalized scan
// surface. Invalid or ambiguous slash expressions remain untouched and are
// still covered by the raw scan.
const regexPrefixWords = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield",
]);
const regexPrefixPunctuation = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">", "/"]);
const regexMetaEscapes = new Set(["A", "B", "b", "D", "d", "G", "K", "k", "p", "P", "s", "S", "W", "w", "Z", "z"]);

function canStartRegex(previous) {
  if (previous === null) return true;
  if (previous.kind === "word") return regexPrefixWords.has(previous.value);
  return previous.kind === "punctuation" && regexPrefixPunctuation.has(previous.value);
}

function readQuotedSource(value, start, quote) {
  let cursor = start + 1;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === quote) return {end: cursor + 1};
    if (value[cursor] === "\n" || value[cursor] === "\r") return {end: cursor};
    cursor += 1;
  }
  return {end: value.length};
}

function readTemplateSource(value, start) {
  let cursor = start + 1;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "`") return {end: cursor + 1};
    cursor += 1;
  }
  return {end: value.length};
}

function readRegexSource(value, start) {
  let cursor = start + 1;
  let inClass = false;
  let escaped = false;
  while (cursor < value.length) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === "\n" || character === "\r") return null;
    if (character === "[") {
      inClass = true;
      cursor += 1;
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      cursor += 1;
      continue;
    }
    if (character === "/" && !inClass) {
      const body = value.slice(start + 1, cursor);
      let flagEnd = cursor + 1;
      while (flagEnd < value.length && /[A-Za-z]/u.test(value[flagEnd])) flagEnd += 1;
      const flags = value.slice(cursor + 1, flagEnd);
      try {
        // Constructor parsing validates the body/flag grammar without ever
        // executing the expression represented by this literal.
        new RegExp(body, flags);
      } catch {
        return null;
      }
      return {end: flagEnd, body};
    }
    cursor += 1;
  }
  return null;
}

function decodeRegexEscape(body, cursor) {
  const next = body[cursor + 1];
  if (next === undefined) return {text: "", end: cursor + 1};
  if (next === "x" && /^[0-9a-f]{2}$/iu.test(body.slice(cursor + 2, cursor + 4))) {
    return {text: String.fromCharCode(Number.parseInt(body.slice(cursor + 2, cursor + 4), 16)), end: cursor + 4};
  }
  if (next === "u") {
    const brace = body[cursor + 2] === "{";
    const close = brace ? body.indexOf("}", cursor + 3) : -1;
    const digits = brace ? body.slice(cursor + 3, close < 0 ? body.length : close) : body.slice(cursor + 2, cursor + 6);
    if (digits.length > 0 && /^[0-9a-f]+$/iu.test(digits) && (!brace || close >= 0)) {
      try {
        return {text: String.fromCodePoint(Number.parseInt(digits, 16)), end: brace ? close + 1 : cursor + 6};
      } catch {
        return {text: " ", end: brace ? close + 1 : cursor + 6};
      }
    }
  }
  if (regexMetaEscapes.has(next) || /[0-9]/u.test(next)) return {text: " ", end: cursor + 2};
  if (next === "c" && body[cursor + 2]) return {text: " ", end: cursor + 3};
  // Escaped punctuation is a literal in a regex pattern. In particular,
  // escaped slash and dot are needed to retain concrete path values.
  return {text: next, end: cursor + 2};
}

function regexLiteralText(body) {
  let output = "";
  let cursor = 0;
  while (cursor < body.length) {
    const character = body[cursor];
    if (character === "\\") {
      const decoded = decodeRegexEscape(body, cursor);
      output += decoded.text;
      cursor = decoded.end;
      continue;
    }
    if (character === "[") {
      let end = cursor + 1;
      let escaped = false;
      while (end < body.length) {
        if (!escaped && body[end] === "]") {
          end += 1;
          break;
        }
        if (!escaped && body[end] === "\\") escaped = true;
        else escaped = false;
        end += 1;
      }
      // A class describes a set of possible characters, not one concrete
      // username. Leave a separator so surrounding literals cannot form one.
      output += " ";
      cursor = end;
      continue;
    }
    if (character === "|" || character === "." || character === "^" || character === "$" || character === "*" || character === "+" || character === "?" || character === "{") {
      output += " ";
      if (character === "{") {
        const close = body.indexOf("}", cursor + 1);
        cursor = close < 0 ? cursor + 1 : close + 1;
      } else {
        cursor += 1;
      }
      continue;
    }
    if (character === "(" && body[cursor + 1] === "?" && body[cursor + 2] === ":") {
      // The colon in a non-capturing group is syntax, not pattern text. Only
      // remove it at the group prefix; colons elsewhere (for example in a
      // credential URL) are literal evidence and must remain in the projection.
      output += " ";
      cursor += 3;
      continue;
    }
    if (character === "}" || character === ")" || character === "(") {
      cursor += 1;
      continue;
    }
    output += character;
    cursor += 1;
  }
  return output;
}

function normalizeJavascriptRegexLiterals(value) {
  let output = "";
  let cursor = 0;
  let previous = null;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\"" || character === "'") {
      const token = readQuotedSource(value, cursor, character);
      output += value.slice(cursor, token.end);
      cursor = token.end;
      previous = {kind: "literal", value: "string"};
      continue;
    }
    if (character === "`") {
      const token = readTemplateSource(value, cursor);
      output += value.slice(cursor, token.end);
      cursor = token.end;
      previous = {kind: "literal", value: "template"};
      continue;
    }
    if (character === "/" && value[cursor + 1] === "/") {
      const newline = value.indexOf("\n", cursor + 2);
      const end = newline < 0 ? value.length : newline;
      output += value.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (character === "/" && value[cursor + 1] === "*") {
      const close = value.indexOf("*/", cursor + 2);
      const end = close < 0 ? value.length : close + 2;
      output += value.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (/\s/u.test(character)) {
      output += character;
      cursor += 1;
      continue;
    }
    if (character === "/" && canStartRegex(previous)) {
      const literal = readRegexSource(value, cursor);
      if (literal) {
        output += regexLiteralText(literal.body);
        cursor = literal.end;
        previous = {kind: "literal", value: "regex"};
        continue;
      }
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = cursor + 1;
      while (end < value.length && /[A-Za-z0-9_$]/u.test(value[end])) end += 1;
      const word = value.slice(cursor, end);
      output += word;
      cursor = end;
      previous = {kind: "word", value: word};
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = cursor + 1;
      while (end < value.length && /[A-Za-z0-9_.]/u.test(value[end])) end += 1;
      output += value.slice(cursor, end);
      cursor = end;
      previous = {kind: "literal", value: "number"};
      continue;
    }
    if (character === "+" && value[cursor + 1] === "+" || character === "-" && value[cursor + 1] === "-") {
      output += value.slice(cursor, cursor + 2);
      cursor += 2;
      previous = {kind: "literal", value: "update"};
      continue;
    }
    output += character;
    cursor += 1;
    previous = {kind: "punctuation", value: character};
  }
  return output;
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
}

/** Expand only literal, local obfuscation forms; never execute source code. */
export function normalizePrivacyText(content) {
  let normalized = String(content);
  for (let pass = 0; pass < 3; pass += 1) {
    const protectedPatternLines = [];
    normalized = normalized.split("\n").map((line) => {
      if (/\[\s*["'](?:LOCAL_ABSOLUTE_PATH|PRIVATE_SSH_URL)["']\s*,/u.test(line)) {
        const marker = `__PUBLIC_PATTERN_LINE_${protectedPatternLines.length}__`;
        protectedPatternLines.push(line);
        return marker;
      }
      return line;
    }).join("\n");
    // Run the regex projection once. Running it on later passes would mistake
    // a projected concrete path for a second regex
    // literal and erase the evidence that the first pass intentionally kept.
    if (pass === 0) normalized = normalizeJavascriptRegexLiterals(normalized);
    const protectedPatternJoins = [];
    normalized = normalized.replace(
      /(\b(?:legacyName|controlDirectory|agentDirectory|localUserPath|privateKeyMarker)\s*=\s*)(\[[^\n]*?\]\s*\.join\(\s*["'][^"']*["']\s*\))/gu,
      (_, prefix, expression) => {
        const marker = `__PUBLIC_PATTERN_JOIN_${protectedPatternJoins.length}__`;
        protectedPatternJoins.push(expression);
        return `${prefix}${marker}`;
      },
    );
    normalized = normalized
      .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\u\{([0-9a-f]+)\}/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\\//gu, "/")
      .replaceAll(/\[-\]/gu, "-")
      .replace(/String\.fromCharCode\(\s*([0-9]+(?:\s*,\s*[0-9]+)*)\s*\)/gu, (_, values) =>
        [...values.matchAll(/[0-9]+/gu)].map((match) => String.fromCharCode(Number(match[0]))).join(""))
      .replace(/(?:atob|Buffer\.from)\(\s*(["'])([A-Za-z0-9+/=]+)\1(?:\s*,\s*["']base64["'])?\s*\)(?:\.toString\(\s*["']utf8["']\s*\))?/gu,
        (_, __, value) => decodeBase64(value));

    normalized = normalized.replace(/\[\s*((?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*)+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\]\s*\.join\(\s*(["'])(.*?)\2\s*\)/gu,
      (_, values, __, separator) => {
        const parts = [...values.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu)]
          .map((match) => evaluateStringLiteral(match[0]))
          .filter((value) => value !== null);
        return parts.length > 0 ? parts.join(separator) : _;
      });
    normalized = normalized.replace(/\[\s*((?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*)+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\]\s*\.reverse\(\)\.join\(\s*(["'])(.*?)\2\s*\)/gu,
      (_, values, __, separator) => {
        const parts = [...values.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu)]
          .map((match) => evaluateStringLiteral(match[0]))
          .filter((value) => value !== null)
          .reverse();
        return parts.length > 0 ? parts.join(separator) : _;
      });
    normalized = normalized
      .replace(/__PUBLIC_PATTERN_JOIN_(\d+)__/gu, (_, index) => protectedPatternJoins[Number(index)])
      .replace(/__PUBLIC_PATTERN_LINE_(\d+)__/gu, (_, index) => protectedPatternLines[Number(index)]);
  }
  return normalized;
}

function sanitizeAllowedPublicMetadata(entry, owner, repositories) {
  const p3Marker = joinParts([".", "context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json"], "");
  const content = entry.content.split(p3Marker).join("[ALLOWED_PUBLIC_P3_MARKER_CONTRACT]");
  if (
    entry.kind === "remote" &&
    repositories.some((name) => content === `https://github.com/${owner}/${name}.git`)
  ) {
    return "[ALLOWED_PUBLIC_GIT_REMOTE]";
  }
  if (entry.kind !== "commit" && entry.kind !== "tag") {
    return content;
  }
  return content
    .split("\n")
    .map((line) => {
      const match = line.match(/^(author|committer|tagger) ([^<>\r\n]+) <((?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com)> \d+ [+-]\d{4}$/u);
      if (!match) {
        return line;
      }
      const [, role, name, , login] = match;
      if (name !== login) {
        return line;
      }
      return `${role} [ALLOWED_PUBLIC_GIT_HOSTING_IDENTITY]`;
    })
    .join("\n");
}

// `repositories` names the public GitHub repositories whose origin URL under `owner` is
// public metadata rather than a private identifier; callers pass the engine's names.
export function scanPrivacyEntries(entries, { owner, privateTokens = [], repositories = [], onProgress = undefined } = {}) {
  if (typeof owner !== "string" || owner.length === 0) {
    throw new Error("PRIVACY_OWNER_REQUIRED");
  }
  if (!Array.isArray(entries)) throw new Error("PRIVACY_ENTRY_INVALID");
  const patterns = privacyPatterns(owner, privateTokens);
  const findings = [];
  const filenameMatches = new Map();
  const archiveExpansions = new Map();
  let totalEntries = 0;
  for (const entry of entries) {
    if (typeof entry?.label !== "string" || typeof entry?.kind !== "string") {
      throw new Error("PRIVACY_ENTRY_INVALID");
    }
    if (entry.releaseArchiveMember !== undefined && typeof entry.releaseArchiveMember !== "boolean") {
      throw new Error("PRIVACY_ENTRY_INVALID");
    }
    if (isSourceArchiveEntry(entry)) {
      if (typeof entry.content !== "string" && !Buffer.isBuffer(entry.content)) throw new Error("PRIVACY_ENTRY_INVALID");
      const expanded = expandSourceArchiveEntry(entry);
      archiveExpansions.set(entry, expanded);
      totalEntries += expanded.length;
    } else {
      if (typeof entry.content !== "string") throw new Error("PRIVACY_ENTRY_INVALID");
      totalEntries += 1;
    }
  }
  let entriesScanned = 0;
  let lastProgressCount = 0;
  for (const originalEntry of entries) {
    for (const entry of archiveExpansions.get(originalEntry) ?? [originalEntry]) {
      // Historical paths repeat in every commit that retains them. Cache only filename
      // predicates: blobs and source strings are high-cardinality, while paths are small
      // and recur heavily. Reusing the predicate result preserves every commit/path
      // finding and its order without re-normalizing the same path thousands of times.
      let matchedReasons = entry.kind === "filename" ? filenameMatches.get(entry.content) : undefined;
      if (matchedReasons === undefined) {
        const content = sanitizeAllowedPublicMetadata(entry, owner, repositories);
        const normalized = normalizePrivacyText(content);
        matchedReasons = [];
        for (const [reasonCode, pattern] of patterns) {
          if (hasUnclassifiedPrivacyMatch(entry, reasonCode, pattern, [content, normalized])) {
            matchedReasons.push(reasonCode);
          }
        }
        if (entry.kind === "filename") filenameMatches.set(entry.content, matchedReasons);
      }
      for (const reasonCode of matchedReasons) {
        findings.push(`${reasonCode}:${entry.kind}:${entry.label}`);
      }

      entriesScanned += 1;
      if (typeof onProgress === "function" && entriesScanned % 5_000 === 0) {
        onProgress({ entriesScanned, totalEntries });
        lastProgressCount = entriesScanned;
      }
    }
  }
  if (typeof onProgress === "function" && lastProgressCount !== entriesScanned) {
    onProgress({ entriesScanned, totalEntries });
  }
  return findings;
}

const gitObjectBatchHeader = /^([a-f0-9]{40,64}) (blob|commit|tag|tree) (0|[1-9][0-9]*)$/u;

// `git cat-file --batch` frames each object as "<oid> SP <type> SP <size> LF <bytes> LF".
// Extraction is length-defined: the payload is a zero-copy subarray sized by the declared
// header count and is never decoded, so it is bit-identical to a per-object raw capture
// even for binary, NUL-bearing and invalid-UTF-8 blobs.
//
// `expectedBytes` is the total stream length implied by the batch-check pass. The
// equality check is an independent backstop against a truncated capture: a short stream
// parses cleanly right up to the cut and would silently drop every object past it,
// leaving the privacy gate green over unscanned history. It holds even if the
// COMMAND_OUTPUT_OVERFLOW guard in local-command.mjs is reverted.
export function parseGitObjectBatch(stream, expectedBytes) {
  if (!Buffer.isBuffer(stream)) {
    throw new Error("PRIVACY_GIT_OBJECT_STREAM_INVALID");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("PRIVACY_GIT_OBJECT_STREAM_INVALID");
  }
  if (stream.length !== expectedBytes) {
    throw new Error("PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE");
  }
  const records = [];
  let cursor = 0;
  while (cursor < stream.length) {
    const headerEnd = stream.indexOf(0x0a, cursor);
    if (headerEnd === -1) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    const match = stream.subarray(cursor, headerEnd).toString("utf8").match(gitObjectBatchHeader);
    if (!match) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    const [, object, type, sizeText] = match;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    const start = headerEnd + 1;
    const content = stream.subarray(start, start + size);
    if (content.length !== size || stream[start + size] !== 0x0a) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    cursor = start + size + 1;
    records.push({ object, type, content });
  }
  return records;
}

export function parseHistoricalTreePaths(content) {
  if (content === "") {
    return [];
  }
  if (typeof content !== "string" || !content.endsWith("\0")) {
    throw new Error("PRIVACY_TREE_RECORD_INVALID");
  }
  return content
    .split("\0")
    .slice(0, -1)
    .map((record) => {
      const match = record.match(/^[0-7]{6} (?:blob|tree|commit) [a-f0-9]{40,64}\t(.+)$/su);
      if (!match || match[1].length === 0) {
        throw new Error("PRIVACY_TREE_RECORD_INVALID");
      }
      return match[1];
    });
}

export function parseGitTreeObject(content, objectIdLength) {
  if (!Buffer.isBuffer(content) || ![40, 64].includes(objectIdLength)) {
    throw new Error("PRIVACY_GIT_OBJECT_TYPE");
  }
  const objectIdBytes = objectIdLength / 2;
  const entries = [];
  let cursor = 0;
  while (cursor < content.length) {
    const modeEnd = content.indexOf(0x20, cursor);
    if (modeEnd === -1) throw new Error("PRIVACY_TREE_RECORD_INVALID");
    const nameEnd = content.indexOf(0x00, modeEnd + 1);
    if (nameEnd === -1) throw new Error("PRIVACY_TREE_RECORD_INVALID");
    const objectStart = nameEnd + 1;
    const objectEnd = objectStart + objectIdBytes;
    if (objectEnd > content.length) throw new Error("PRIVACY_TREE_RECORD_INVALID");

    const mode = content.subarray(cursor, modeEnd).toString("ascii");
    if (!/^(?:100644|100755|120000|040000|40000|160000)$/u.test(mode)) {
      throw new Error("PRIVACY_TREE_RECORD_INVALID");
    }
    const nameBytes = content.subarray(modeEnd + 1, nameEnd);
    if (nameBytes.length === 0 || nameBytes.includes(0x2f)) throw new Error("PRIVACY_TREE_RECORD_INVALID");
    const name = decodeGitMetadataBytes(nameBytes, "PRIVACY_TREE_UTF8_INVALID");
    const type = mode === "40000" || mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
    entries.push({ name, object: content.subarray(objectStart, objectEnd).toString("hex"), type });
    cursor = objectEnd;
  }
  return entries;
}

function parseCommitTreeId(content, objectIdLength) {
  if (!Buffer.isBuffer(content)) throw new Error("PRIVACY_GIT_OBJECT_TYPE");
  const lineEnd = content.indexOf(0x0a);
  if (lineEnd === -1) throw new Error("PRIVACY_GIT_OBJECT_TYPE");
  const firstLine = content.subarray(0, lineEnd).toString("ascii");
  const match = firstLine.match(/^tree ([a-f0-9]{40}|[a-f0-9]{64})$/u);
  if (!match || match[1].length !== objectIdLength) throw new Error("PRIVACY_GIT_OBJECT_TYPE");
  return match[1];
}

export async function walkHistoricalCommitPaths(commits, historyRecords, visitPath, onCommitProgress = undefined) {
  if (!Array.isArray(commits) || !Array.isArray(historyRecords) || typeof visitPath !== "function") {
    throw new Error("PRIVACY_TREE_RECORD_INVALID");
  }
  if (onCommitProgress !== undefined && typeof onCommitProgress !== "function") {
    throw new Error("PRIVACY_TREE_RECORD_INVALID");
  }
  if (commits.length === 0) return { commits: 0, historicalPaths: 0 };
  const commitTrees = new Map();
  const trees = new Map();
  const objectIdLength = commits[0]?.length;
  if (commits.some((commit) => typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) || commit.length !== objectIdLength)) {
    throw new Error("PRIVACY_GIT_OBJECT_TYPE");
  }

  for (const record of historyRecords) {
    const match = typeof record?.path === "string" ? record.path.match(/^(commit|tree):([a-f0-9]{40}|[a-f0-9]{64})$/u) : null;
    if (!match) continue;
    const [, type, object] = match;
    if (object.length !== objectIdLength || !Buffer.isBuffer(record.content)) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    if (type === "commit") {
      commitTrees.set(object, parseCommitTreeId(record.content, objectIdLength));
    } else {
      trees.set(object, parseGitTreeObject(record.content, objectIdLength));
    }
  }

  let historicalPaths = 0;
  for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
    const commit = commits[commitIndex];
    const rootTree = commitTrees.get(commit);
    if (rootTree === undefined || !trees.has(rootTree)) throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    let pathsInCommit = 0;
    const stack = [{ tree: rootTree, prefix: "", entries: trees.get(rootTree), nextIndex: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame.nextIndex >= frame.entries.length) {
        stack.pop();
        continue;
      }
      const entry = frame.entries[frame.nextIndex];
      frame.nextIndex += 1;
      const path = frame.prefix === "" ? entry.name : `${frame.prefix}/${entry.name}`;
      if (entry.type === "tree") {
        const children = trees.get(entry.object);
        if (children === undefined) throw new Error("PRIVACY_GIT_OBJECT_TYPE");
        stack.push({ tree: entry.object, prefix: path, entries: children, nextIndex: 0 });
      } else {
        visitPath(commit, path, entry.object);
        pathsInCommit += 1;
        historicalPaths += 1;
      }
    }
    if (onCommitProgress !== undefined) {
      await onCommitProgress({
        commit,
        completedCommits: commitIndex + 1,
        totalCommits: commits.length,
        pathsInCommit,
        historicalPaths,
      });
    }
  }
  return { commits: commits.length, historicalPaths };
}
