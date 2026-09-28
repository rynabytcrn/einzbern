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
    }
  ],
  "currentSources": [
    {
      "path": "portal/index.html",
      "bytes": 296847,
      "sha256": "3c72ec6dbcf58d0cd7dd1f416a5c1824ff83c51ea2c6331e8bad6b7e174e8600"
    },
    {
      "path": "portal/locales.js",
      "bytes": 113524,
      "sha256": "e8cb567bdf7f9c39baa2d13bf2249bc737bd70dabfb1942860a43a67cb54a222"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 38350,
      "sha256": "5cfdb907e96896821af460b59ce06127080ad652cc12228eec81aa4324911698"
    },
    {
      "path": "portal/scripts/i18n-proof.mjs",
      "bytes": 16231,
      "sha256": "273da5bedad917093f48d50a1ad97f3ea2df773c45ce12ee0565cee169d2778d"
    },
    {
      "path": "portal/scripts/proof.mjs",
      "bytes": 790,
      "sha256": "898da358d7bbc21912b28051ebf93544fd51bdca70f06466c499b943be3d5351"
    },
    {
      "path": "portal/tests/portal.test.mjs",
      "bytes": 67787,
      "sha256": "eb4610502e5b49a624f25941fd9eec0aadd7ed16e531869282d59a42d902542b"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 113995,
      "sha256": "0126bff9f9952219fb0f93da5cb650ec8791bc4bf7e8eca9afae267e6dfb1800"
    },
    {
      "path": "packages/core/src/doctor.ts",
      "bytes": 30839,
      "sha256": "def4e03cf8eb88f5f1c7d7dda2732b7b6be9f3596444eb0f5da4aee5f5489cda"
    },
    {
      "path": "tests/doctor.test.mjs",
      "bytes": 16405,
      "sha256": "2877b101fba3f0295e409ee88188e184028fb993c7933dd3518462f4f721f3ad"
    },
    {
      "path": "scripts/verify-portal.mjs",
      "bytes": 2976,
      "sha256": "f430fe0e545e407148de6806e8215cd2b473d39598fa900dcc3f926e02523b4d"
    },
    {
      "path": "scripts/verbatim-evidence-meta-proof.mjs",
      "bytes": 4884,
      "sha256": "e3a29d25a320bb07f4a93c5495b2cbcec7f4adf8957799c34c0c0d764bef106b"
    },
    {
      "path": "scripts/verbatim-evidence-proof.mjs",
      "bytes": 21101,
      "sha256": "4c8a78bde608ccbc932e79798248505b60324e2cb060fa98886f657719067aac"
    }
  ],
  "hostRoleScan": {
    "scan": "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u",
    "exitCode": 0,
    "matchCount": 1,
    "matches": [
      "if (!host || !tier || currentRows.some((row) => row.host === host && row.tier === tier)) {"
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
        "keyCount": 304,
        "localeCount": 5,
        "expectedStrings": 1520,
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
