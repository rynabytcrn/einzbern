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
      "bytes": 428745,
      "sha256": "db0e8700a6fa8bcc74211a3034b75a8c57242be109eb7b85a7db1fbb8765ae8f"
    },
    {
      "path": "portal/locales.js",
      "bytes": 234347,
      "sha256": "12b55d0397da7ae466800a27a9e670969de09fa917759663af8e87d286b19b0f"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 84751,
      "sha256": "3a71440f605d77eb083747868fee6fdb2ea3aee26096e25d43065ccf763fc660"
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
      "bytes": 160512,
      "sha256": "de8400fd41756c8c66db46f7eb4ce43454603d2531f413b32f3b851d035bdcfd"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 280876,
      "sha256": "9159e4a8b48a538e43a6dc32ae10d51546120d439ad1ccd4e06265c2aed3bc2a"
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
      "bytes": 4884,
      "sha256": "e3a29d25a320bb07f4a93c5495b2cbcec7f4adf8957799c34c0c0d764bef106b"
    },
    {
      "path": "scripts/verbatim-evidence-proof.mjs",
      "bytes": 26144,
      "sha256": "c47a6b612329d28ec7056265eb642993d98161b2869d32f1991d4f61017fc650"
    }
  ],
  "hostRoleScan": {
    "scan": "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u",
    "exitCode": 0,
    "matchCount": 11,
    "matches": [
      "$(\"#design-authority\").hidden = state.settings?.chain?.role === \"coordination\" || state.settingGroup !== authorityGroup || designAuthorityState.status === \"unset\";",
      ": target?.chain?.role === \"coordination\" ? t(\"projects.coordination\") : t(\"projects.unnamed\");",
      "const chainRoleLabel = (role) => role === \"coordination\" ? t(\"chainIdentity.roleCoordination\") : role === \"project\" ? t(\"chainIdentity.roleProject\") : t(\"chainIdentity.undeclared\");",
      "const collectionReadOnly = (key) => state.settings?.chain?.role === \"coordination\" && Array.isArray(state.settings?.settings) && currentSetting(key) === undefined;",
      "const declared = BOOT.library?.chain?.role === \"project\" ? BOOT.library.chain.coordinationLibraryId : null;",
      "const registered = (BOOT.libraries || []).filter((library) => library.chain?.role === \"coordination\" && library.libraryId !== own).map((library) => library.libraryId);",
      "const rendersSystemVariables = (key) => String(key) === \"artifact.language\" || String(key).startsWith(\"design.\") || (state.settings?.chain?.role === \"coordination\"",
      "if (!state.chainDeclarePending) $(\"[data-chain-role]\", form).value = identity?.role === \"coordination\" ? \"coordination\" : \"project\";",
      "if (role === \"coordination\") return own ? [own] : [];",
      "select.disabled = role === \"coordination\" || choices.length === 0;",
      "select.hidden = state.settings?.chain?.role === \"coordination\";"
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
        "keyCount": 546,
        "localeCount": 5,
        "expectedStrings": 2730,
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
