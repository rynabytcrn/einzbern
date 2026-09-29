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
      "bytes": 339400,
      "sha256": "091f583562bea814875528c9fc5ede640e6b9d73d76774e1869951af798df6d5"
    },
    {
      "path": "portal/locales.js",
      "bytes": 149307,
      "sha256": "6eba0a4efc19884c392d71c8e7ee564b19f9a9189664a9ab46623bbfc4ffa3ba"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 54566,
      "sha256": "1614c3d6f8fb0beae04b241b02b58c417ce70c2573f02866f1eef4ed90de0a28"
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
      "bytes": 115749,
      "sha256": "7bcf339b6b1c9b894cf8aad2c80679dca9f4d9a501869fdef7a791cf982e0c95"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 169692,
      "sha256": "50283537cfa8a18a1ce1432149df54978ba5fee732f47f8a3568278b45761e9a"
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
      "bytes": 21821,
      "sha256": "6f3263a97a4a836400c85361db47b408b39ec25bb115cf17508cacea45399ef5"
    }
  ],
  "hostRoleScan": {
    "scan": "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u",
    "exitCode": 1,
    "matchCount": 0,
    "matches": []
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
        "keyCount": 373,
        "localeCount": 5,
        "expectedStrings": 1865,
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
