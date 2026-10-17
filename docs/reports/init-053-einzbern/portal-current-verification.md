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
      "bytes": 474492,
      "sha256": "bcd677617d563ac4df5257f41661103d65fc0791cd31a66ae1b0ca56f5a18f56"
    },
    {
      "path": "portal/locales.js",
      "bytes": 264798,
      "sha256": "d58271a4d50de8cc09ab49d4fffa10919dd9e72fe2288106ff34e28883bfcf0a"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 87750,
      "sha256": "05d7ac3ddc207cc2c39a50bb927e17641c8d01ae14a5d252c10237da4c5008ae"
    },
    {
      "path": "portal/scripts/i18n-proof.mjs",
      "bytes": 16499,
      "sha256": "56895e7049afd72b76d4346f31446e8dacd04d8ca5143fe546a96eac17bb8079"
    },
    {
      "path": "portal/scripts/proof.mjs",
      "bytes": 790,
      "sha256": "898da358d7bbc21912b28051ebf93544fd51bdca70f06466c499b943be3d5351"
    },
    {
      "path": "portal/tests/portal.test.mjs",
      "bytes": 163008,
      "sha256": "127ee852c8d8ff633a2e73ee7aaa4e1ebd22fdcf31ecf0e4e69dac7b53345582"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 293281,
      "sha256": "5b1f76efae419d66068cb9424ce70d398aafa3bf21616c2ee3e2b84bc91b66ef"
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
      "bytes": 34886,
      "sha256": "46e1b39541374dffbd6bfee212ec01819963c52f6fb8f1f2c6a1e3b753007d8c"
    },
    {
      "path": "tests/doctor.test.mjs",
      "bytes": 26519,
      "sha256": "c3865eb7236140f39a402f2a38e8e6dfc0d18632c80f9742ba66cc803ade1356"
    },
    {
      "path": "scripts/verify-portal.mjs",
      "bytes": 3466,
      "sha256": "fb8fcdb2ee1ca0b2b818fd6de7da03825dca79582f8f57bad1b36a451cf48c76"
    },
    {
      "path": "scripts/verbatim-evidence-meta-proof.mjs",
      "bytes": 5059,
      "sha256": "ad03a232528f965b3522f9a278d3a62247dfbc488eca58e395898b0874638ebe"
    },
    {
      "path": "scripts/verbatim-evidence-proof.mjs",
      "bytes": 26249,
      "sha256": "a1b908d6a1aab51c30c830f0ac7a6d20e2778baa2c9e5c4df7eb834952018cd1"
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
      "const state = { locale: storedLocale ?? (Object.keys(LOCALES).includes(BOOT.machineDefaults?.locale) ? BOOT.machineDefaults.locale : null) ?? BOOT.defaultLocale ?? \"en\", theme: document.documentElement.dataset.tcrnTheme, page: \"dashboard\", dashboardTab: \"overview\", settingGroup: \"general\", collections: { \"models.category\": { draft: null, dirty: false, findings: [], refusal: null }, \"models.tiers\": { draft: null, dirty: false, findings: [], refusal: null } }, collectionFocus: null, transientTargetTimer: null, settings: null, machineSettings: null, modelPolicy: null, modelPolicyHost: \"codex\", modelPolicyDrafts: new Map(), modelPolicyWrites: new Map(), modelPolicyRead: 0, modelPolicyReadTarget: null, modelPolicyReadPending: false, modelPolicyLibraryId: BOOT.library?.libraryId ?? null, variables: null, vocabulary: null, status: null, work: null, workRead: { library: 0, readingFor: null, again: false }, knowledge: null, knowledgeQuery: \"\", knowledgeStatus: \"valid\", knowledgeBody: null, gates: [], gateResponse: null, lastGateRun: null, commands: [], selectedVocabulary: \"conferenceTypes\", receipt: null, operationDetailsOpen: false, agentsText: \"\", reconciliation: null, rules: null, pendingSection: \"\", searchIndex: [], searchResults: [], searchSelection: 0 };",
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
        "keyCount": 617,
        "localeCount": 5,
        "expectedStrings": 3085,
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
