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
      "bytes": 344734,
      "sha256": "936e176d5b718ecca89beeea6ec9d18c6375984c72ed11db0b40dcda973f4736"
    },
    {
      "path": "portal/locales.js",
      "bytes": 185047,
      "sha256": "696e9c83bcd33999ad7a95791a0da56ca0af04ebc5763feef2d3d4fddf672757"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 60991,
      "sha256": "7e3085d89ce0afb056e628c1d42db09a328a3f4b575a15f1ad70dff23dc5c75c"
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
      "bytes": 121668,
      "sha256": "a1267087cfb306b9131b2ebf5220d974dc6010e2543cabf8f540d9ce9309456d"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 182707,
      "sha256": "f38118b0068300d15970749ac659e06e9e57e5a0e45b2b3d6a7ac092a66ec993"
    },
    {
      "path": "packages/core/src/doctor.ts",
      "bytes": 30974,
      "sha256": "a096ad19e497781fa785020a748d86228bccc11b2771370b3f0fe74624527ed7"
    },
    {
      "path": "tests/doctor.test.mjs",
      "bytes": 17001,
      "sha256": "d0aa085e459d97f3c3e9f55d419a4004073958524caa1c072338f501ceed550e"
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
      "bytes": 21816,
      "sha256": "86ff4f69c37045868c3b92d9e270f8e84181a5bca20358e9d9a068e5aa70e625"
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
        "keyCount": 417,
        "localeCount": 5,
        "expectedStrings": 2085,
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
