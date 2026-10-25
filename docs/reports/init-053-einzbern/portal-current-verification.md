# INIT-053 current Portal verification

This record covers the current Portal tree. Historical INC-153 and INC-155 evidence remains bound to its original commits and bytes; `verify:portal` replays those blocks in their historical source snapshots, then checks the current sources and five-locale proof below.

```verbatim:node scripts/verbatim-evidence-proof.mjs init053-current-portal-proof
{
  "schemaVersion": "tcrn.init053-current-portal-proof.v1",
  "historicalEvidence": [
    {
      "path": "docs/reports/init-028-design/evidence/INC-153-restore-and-docs.md",
      "commit": "390eb5a1578dcd1086bde6b7c717ab1553d054b9",
      "committedAt": "2026-09-12T09:46:08+08:00",
      "bytes": 2758,
      "sha256": "e05b14591927af0df67dacf3eaabf4f7c12b4892111e8d350bc69b393aafe139",
      "command": "node scripts/verbatim-evidence-proof.mjs inc153-host-role-scan",
      "outputBytes": 560,
      "outputSha256": "89f414561a0f1d2f13e0431252f9801fc628f677efdc49e5060c3495fc004c9f"
    },
    {
      "path": "docs/reports/init-028-design/evidence/INC-155-coverage-integrity.md",
      "commit": "4058d96e83c696c7faf319b1c1d94face4219554",
      "committedAt": "2026-09-24T09:51:27+08:00",
      "bytes": 12416,
      "sha256": "438921486a1154e958a5adefdda3f80c9a80a4bdfb1ec53c637d67f55e58d97a",
      "command": "node scripts/coverage-conservation-proof.mjs",
      "outputBytes": 2048,
      "outputSha256": "6d5b7fe9a7e8b44981e84ea2e544b7ed104697faf2a631bf62a6642933e168ec"
    },
    {
      "path": "docs/reports/init-029-component-loop/evidence/STORY-252-ds-css-snapshot.md",
      "commit": "f58a238b2df55bd9c55144ea718cf807dc1dc5f1",
      "committedAt": "2026-10-14T06:51:28+08:00",
      "bytes": 5188,
      "sha256": "677ccd503004af2fb26370e2f5317082b913f10f5799667d27c26f16309a27c0",
      "command": "node scripts/ds-component-css-proof.mjs",
      "outputBytes": 1167,
      "outputSha256": "34649dc46d51fee1367a96f20515f7d186cbac0391c8250cb48019abf477cca9"
    }
  ],
  "currentSources": [
    {
      "path": "portal/index.html",
      "bytes": 499771,
      "sha256": "9cba6254e2d99ab76195e0bf0ff9d227c245a29621fde2c587df65a6c6a5b880"
    },
    {
      "path": "portal/locales.js",
      "bytes": 284983,
      "sha256": "140a5a2bf331b0bc8a48cfcaff9be59782c3e7ccc6a4470470bff2176c602bc7"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 93015,
      "sha256": "6ffd387aaa797663cc43348c4fd018320ea9dc45ab0127cf99a1cf0502815c34"
    },
    {
      "path": "portal/scripts/i18n-proof.mjs",
      "bytes": 16967,
      "sha256": "3fbed5d5a041c72051f844406dff582aa53ac509d6f30f3f75f7305661578903"
    },
    {
      "path": "portal/scripts/proof.mjs",
      "bytes": 790,
      "sha256": "898da358d7bbc21912b28051ebf93544fd51bdca70f06466c499b943be3d5351"
    },
    {
      "path": "portal/tests/portal.test.mjs",
      "bytes": 37447,
      "sha256": "9559f33a042186f29f28320ed2bc90d0758c7c07c978aa7c27d8e59ee8c0e5ef"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 88565,
      "sha256": "598577afe1ff7ccc94f1cb7e9293a8218b46ae3a23b7841015d4e0945694bbf0"
    },
    {
      "path": "portal/tests/ui-presence-support.mjs",
      "bytes": 51996,
      "sha256": "cc32f549566fb3ea2b45a0eb5a30bb3845bf1387b0ebcf410e303dd8b400b73e"
    },
    {
      "path": "portal/tests/portal-support.mjs",
      "bytes": 20844,
      "sha256": "8f36caa503a04529147624e2f96262164519789e09b0521433b0f4bd2c44f74b"
    },
    {
      "path": "portal/tests/portal-work.test.mjs",
      "bytes": 29874,
      "sha256": "3325d18ac08202bfa79f81b3b9c312be9d08c964492351ba6d7342404d1ee907"
    },
    {
      "path": "portal/tests/portal-configuration.test.mjs",
      "bytes": 54490,
      "sha256": "2e8202fb3910f53d30fce313702874b3612672caf0451cceb6ed3c62c0a31f43"
    },
    {
      "path": "portal/tests/portal-library.test.mjs",
      "bytes": 31190,
      "sha256": "5323ea41413d639daac96b987bfa9b2138906c3c371ba5b529a3a9d48e98d9c1"
    },
    {
      "path": "portal/tests/ui-work.test.mjs",
      "bytes": 60881,
      "sha256": "440c4e5be1d6d8ba3cc18029f11eec31eeebf9a8ce8522330141f9253b99b3af"
    },
    {
      "path": "portal/tests/ui-configuration.test.mjs",
      "bytes": 118986,
      "sha256": "502051e1c55c3969fd41d8b793db5e6087cf0ec6ff6f030b19981d17a39a26ed"
    },
    {
      "path": "portal/tests/ui-library.test.mjs",
      "bytes": 38370,
      "sha256": "636dd9167ea3804c25fb918664460e0e93db5c8a553036c1b89fdcb33df5aeb2"
    },
    {
      "path": "tests/helpers/register-portal-libraries.mjs",
      "bytes": 2243,
      "sha256": "9b04d75c13c86894003fc5261e925f66419c5f49cd653a806a00aa56acf4ddcf"
    },
    {
      "path": "scripts/portal-tests.mjs",
      "bytes": 987,
      "sha256": "6728e4a61bfc2fc3f3d1536d4d639eb2c25ce1fc2aa614bc79bbb69eb1386502"
    },
    {
      "path": "scripts/lib/test-roster.mjs",
      "bytes": 941,
      "sha256": "d907c71a875121d21d6b9cbb3bb63d9039240f0186b851588392a5d1bdfbcdc8"
    },
    {
      "path": "scripts/lib/verification-evidence.mjs",
      "bytes": 1515,
      "sha256": "91a3b99f18e1546a76697613b6a622977ee5e81b853af1a7f330030b675e76b2"
    },
    {
      "path": "portal/tests/disposable-portal-fetch.test.mjs",
      "bytes": 3592,
      "sha256": "bd33b82655afc88abe8f3ad77b219cd03d1650a8ed4979da439cccd0dd4e1e80"
    },
    {
      "path": "portal/tests/helpers/disposable-portal-fetch.mjs",
      "bytes": 790,
      "sha256": "8fb381787cc63f2286b462330f86f9aa69bb721680c9651aec01a75619c7a82b"
    },
    {
      "path": "packages/core/src/doctor.ts",
      "bytes": 35804,
      "sha256": "8c2f533f00a467681195ab9cbbab3a14f64c3c9459c5e5cc263857b8b433c685"
    },
    {
      "path": "tests/doctor.test.mjs",
      "bytes": 27959,
      "sha256": "2ef3298b60b59103a842927e1bb93858a4a8d03a1a126b8484cd7619b1cf9863"
    },
    {
      "path": "scripts/verify-portal.mjs",
      "bytes": 4849,
      "sha256": "d431fcbc8fc997755a7963057fa8e777dda35b0ddd206aab6258515c56741007"
    },
    {
      "path": "scripts/verbatim-evidence-meta-proof.mjs",
      "bytes": 5368,
      "sha256": "83287b2f71d61b0c0a2046607488abd8aa9da0aa02e1bba2ce78a14137552741"
    },
    {
      "path": "scripts/verbatim-evidence-proof.mjs",
      "bytes": 28296,
      "sha256": "950d250073836a82a4905fe290f91938bd78146df3d04c9c844e90b651b0e22b"
    }
  ],
  "hostRoleScan": {
    "scan": "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u",
    "exitCode": 0,
    "matchCount": 18,
    "matches": [
      "$(\"#design-authority\").hidden = state.settings?.chain?.role === \"coordination\" || state.settingGroup !== authorityGroup || designAuthorityState.status === \"unset\";",
      ": `<section class=\"tcrn-surface\" data-content-scope=\"custom-variables\"><div class=\"tcrn-surface__head\"><div class=\"tcrn-surface__head-content\"><h2>${esc(t(\"variables.title\"))}</h2><p class=\"tcrn-text\">${esc(t(\"variables.note\"))}</p><p class=\"tcrn-text\">${esc(t(\"variables.replaceNote\"))}</p>${independentConfigurationMetadata(\"variable\", { scope: state.settings?.chain?.role === \"coordination\" ? \"library\" : \"project\" })}</div></div><div class=\"tcrn-table-shell tcrn-variable-table\" role=\"table\" aria-label=\"${esc(t(\"variables.title\"))}\" data-variable-table=\"true\"><div class=\"tcrn-table-shell__head\" role=\"row\">${headers.map((label) => `<span role=\"columnheader\">${esc(label)}</span>`).join(\"\")}</div>${variableRow({ name: \"\", type: \"string\", value: \"\", description: \"\" }, true)}${rows}</div></section>${source?.withheld?.length ? `<p class=\"tcrn-text\">${esc(t(\"variables.withheld\", { count: source.withheld.length }))}</p>` : \"\"}`;",
      ": target?.chain?.role === \"coordination\" ? t(\"projects.coordination\") : t(\"projects.unnamed\");",
      "const catalog = state.modelPolicy?.selectedHost === host ? state.modelPolicy : null;",
      "const chainRoleLabel = (role) => role === \"coordination\" ? t(\"chainIdentity.roleCoordination\") : role === \"project\" ? t(\"chainIdentity.roleProject\") : t(\"chainIdentity.undeclared\");",
      "const collectionReadOnly = (key) => state.settings?.chain?.role === \"coordination\" && Array.isArray(state.settings?.settings) && currentSetting(key) === undefined;",
      "const declared = BOOT.library?.chain?.role === \"project\" ? BOOT.library.chain.coordinationLibraryId : null;",
      "const modelPolicyHostControl = (host, pending) => `<label class=\"tcrn-field\"><span class=\"tcrn-field__label\">${esc(t(\"modelPolicy.host\"))}</span><select class=\"tcrn-select\" data-engine-model-policy-host aria-label=\"${esc(t(\"modelPolicy.host\"))}\" ${pending ? \"disabled\" : \"\"}>${modelPolicyHosts().map((name) => `<option value=\"${esc(name)}\"${name === host ? \" selected\" : \"\"}>${esc(name)}</option>`).join(\"\")}</select></label>`;",
      "const modelPolicyPendingFor = (host) => state.modelPolicyReadPending === true && state.modelPolicyReadTarget?.host === host && modelPolicyReadCurrent(state.modelPolicyReadTarget);",
      "const registered = (BOOT.libraries || []).filter((library) => library.chain?.role === \"coordination\" && library.libraryId !== own).map((library) => library.libraryId);",
      "const rendersSystemVariables = (key) => String(key) === \"artifact.language\" || String(key).startsWith(\"design.\") || (state.settings?.chain?.role === \"coordination\"",
      "const state = { locale: storedLocale ?? (Object.keys(LOCALES).includes(BOOT.machineDefaults?.locale) ? BOOT.machineDefaults.locale : null) ?? BOOT.defaultLocale ?? \"en\", theme: document.documentElement.dataset.tcrnTheme, page: \"dashboard\", dashboardTab: \"overview\", settingGroup: \"general\", collections: { \"models.category\": { draft: null, dirty: false, findings: [], refusal: null }, \"models.tiers\": { draft: null, dirty: false, findings: [], refusal: null } }, collectionFocus: null, transientTargetTimer: null, settings: null, machineSettings: null, configBackups: null, modelPolicy: null, modelPolicyHost: \"codex\", modelPolicyDrafts: new Map(), modelPolicyWrites: new Map(), modelPolicyRead: 0, modelPolicyReadTarget: null, modelPolicyReadPending: false, modelPolicyLibraryId: BOOT.library?.libraryId ?? null, variables: null, vocabulary: null, status: null, work: null, workRead: { library: 0, readingFor: null, again: false }, knowledge: null, knowledgeQuery: \"\", knowledgeStatus: \"valid\", knowledgeBody: null, gates: [], gateResponse: null, lastGateRun: null, commands: [], selectedVocabulary: \"conferenceTypes\", receipt: null, operationDetailsOpen: false, agentsText: \"\", reconciliation: null, rules: null, pendingSection: \"\", searchIndex: [], searchResults: [], searchSelection: 0 };",
      "if (!state.chainDeclarePending) $(\"[data-chain-role]\", form).value = identity?.role === \"coordination\" ? \"coordination\" : \"project\";",
      "if (role === \"coordination\") return own ? [own] : [];",
      "return [...new Set([\"codex\", ...configured])].sort();",
      "select.disabled = role === \"coordination\" || choices.length === 0;",
      "select.hidden = state.settings?.chain?.role === \"coordination\";",
      "target: configurationTarget(state.settings?.chain?.role === \"coordination\" ? \"library\" : \"project\"),"
    ]
  },
  "i18n": {
    "sourceCommand": "node portal/scripts/i18n-proof.mjs",
    "ok": true,
    "reasonCode": "I18N_CONTRACT_SATISFIED",
    "legs": [
      {
        "leg": "contract-snapshot",
        "ok": true,
        "reasonCode": "I18N_CONTRACT_SNAPSHOT_READY",
        "source": "portal/locale-contract.mjs"
      },
      {
        "leg": "locale-set",
        "ok": true,
        "reasonCode": "LOCALE_SET_MATCHES_CONTRACT",
        "missingLocales": [],
        "extraLocales": []
      },
      {
        "leg": "key-coverage",
        "ok": true,
        "reasonCode": "EVERY_KEY_TRANSLATED",
        "keyCount": 684,
        "localeCount": 5,
        "expectedStrings": 3420,
        "gaps": []
      },
      {
        "leg": "translation-reality",
        "ok": true,
        "reasonCode": "TRANSLATIONS_DIFFER_FROM_ENGLISH",
        "addedKeyCount": 0,
        "gaps": []
      },
      {
        "leg": "translation-full-table",
        "ok": true,
        "reasonCode": "FULL_LOCALE_TABLE_TRANSLATED",
        "baselineEqualCount": {
          "zh-CN": 33,
          "ja": 21,
          "ko": 21,
          "fr": 21
        },
        "problems": []
      },
      {
        "leg": "key-reachability",
        "ok": true,
        "reasonCode": "EVERY_LOCALE_KEY_REACHABLE",
        "unreachable": []
      },
      {
        "leg": "placeholders",
        "ok": true,
        "reasonCode": "PLACEHOLDERS_CONSISTENT",
        "gaps": []
      },
      {
        "leg": "setting-descriptions",
        "ok": true,
        "reasonCode": "EVERY_SETTING_DESCRIBED"
      }
    ]
  }
}
```
