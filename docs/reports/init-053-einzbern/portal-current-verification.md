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
      "bytes": 373257,
      "sha256": "1dee1b656a163eac80606824937f39657dec08df2bdd3e1a1a8e383d2921353e"
    },
    {
      "path": "portal/locales.js",
      "bytes": 197983,
      "sha256": "db808426a4b3a755506f5d1eee4fa6c3565cc497c574f4ccaebedb4d4b2c1abe"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 66727,
      "sha256": "8e2947917ffdaa456563234476537ab42836be7105de1d968a99e3e43c04eb3b"
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
      "bytes": 127672,
      "sha256": "5c7fe955129e79b4d33b9f200e594f5ca924d04871b1fac0431730a9336053db"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 213731,
      "sha256": "1268b970bf6989bd65090be2084c2679c80bcc030e93a10352dbe9c04df3dbd1"
    },
    {
      "path": "packages/core/src/doctor.ts",
      "bytes": 30986,
      "sha256": "17fa586350ff27e30016a3758de0568690e189d7cd194c90d29c2729bb037cc2"
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
    "exitCode": 0,
    "matchCount": 3,
    "matches": [
      "$(\"#design-authority\").hidden = state.settings?.chain?.role === \"coordination\" || state.settingGroup !== authorityGroup || designAuthorityState.status === \"unset\";",
      ": target?.chain?.role === \"coordination\" ? t(\"projects.coordination\") : t(\"projects.unnamed\");",
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
        "keyCount": 465,
        "localeCount": 5,
        "expectedStrings": 2325,
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
