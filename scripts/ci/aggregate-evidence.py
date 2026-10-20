#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Fail closed unless every expected shard retained passing evidence for this run."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("p1_evidence", Path(__file__).with_name("p1-evidence.py"))
evidence_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence_runner)


def judge_shards(records, plan, sha, run_id, attempt):
    failures = []
    if set(records) != set(plan["shards"]):
        failures.append("Missing or unexpected P1 shard")
    covered = []
    for shard, tasks in plan["shards"].items():
        meta = records.get(shard, {})
        if meta.get("mode") != f"p1-{shard}" or meta.get("input", {}).get("head") != sha:
            failures.append(f"{shard}: mode or source SHA mismatch")
        if meta.get("ciIdentity") != {"GITHUB_RUN_ID": run_id, "GITHUB_RUN_ATTEMPT": attempt}:
            failures.append(f"{shard}: evidence belongs to another run or attempt")
        final = meta.get("finalShardReceipt", {})
        for key, expected in (("legs", tasks), ("prerequisites", plan["prerequisites"][shard]), ("extras", ["test-wiring"] if shard == "checks" else [])):
            block = final if key == "legs" else final.get(key, {})
            legs = block.get("legs", [])
            if [row.get("task") for row in legs] != expected or any(row.get("ok") is not True for row in legs) or block.get("reds") != []:
                failures.append(f"{shard}: {key} missing, duplicated, reordered, or failed")
        covered.extend(row.get("task") for row in final.get("legs", []))
    if sorted(covered) != sorted(plan["tasks"]):
        failures.append("Shard union differs from the complete P1 roster")
    return failures


def validate_directory(directory, mode, sha):
    config = evidence_runner.mode_config(mode)
    meta = json.loads((directory / f"{config['label']}.meta.json").read_text())
    failures = evidence_runner.verify_retained_artifacts(directory, meta)
    failures.extend(evidence_runner.evaluate(meta))
    if meta.get("input", {}).get("head") != sha or meta.get("mode") != mode:
        failures.append("Artifact source SHA/mode mismatch")
    stream, final = evidence_runner.final_receipt(
        (directory / f"{config['label']}.stdout").read_bytes(),
        (directory / f"{config['label']}.stderr").read_bytes())
    if final != meta.get(config["receiptKey"]) or stream != meta.get("finalReceiptStream"):
        failures.append("Final receipt differs from retained output")
    if json.loads((directory / "receipt.json").read_text()) != meta.get("receipt") or meta.get("receipt", {}).get("ok") is not True:
        failures.append("Wrapper receipt missing, altered, or failed")
    if mode.startswith("p1-"):
        if json.loads((directory / "shard.json").read_text()) != final:
            failures.append("Retained shard receipt differs from final output")
        for prefix, block in (("leg", final), ("prerequisite", final.get("prerequisites", {})), ("extra", final.get("extras", {}))):
            for leg in block.get("legs", []):
                name = f"steps/{prefix}-{leg['task']}"
                for suffix in (".json", ".stdout", ".stderr"):
                    if name + suffix not in meta.get("extraArtifacts", {}):
                        failures.append(f"{name + suffix}: missing from hashed artifacts")
                step = json.loads((directory / (name + ".json")).read_text())
                if step.get("exitCode") != 0 or step.get("signal") is not None:
                    failures.append(f"{name}: child failed or was cancelled")
        if mode == "p1-core":
            _, core = evidence_runner.final_receipt((directory / "steps/leg-test.stdout").read_bytes(), (directory / "steps/leg-test.stderr").read_bytes())
            if core.get("tests") != meta.get("inputManifest", {}).get("coreTestFiles"):
                failures.append("Core executed test-file roster differs from source")
        if mode == "p1-portal":
            if "portal/test-roster.json" not in meta.get("extraArtifacts", {}) or json.loads((directory / "portal/test-roster.json").read_text()) != meta.get("inputManifest", {}).get("portalTestFiles"):
                failures.append("Portal executed test-file roster differs from source")
            portal = json.loads((directory / "portal/receipt.json").read_text())
            if portal.get("ok") is not True or len(portal.get("timings", [])) != 6:
                failures.append("Portal train incomplete")
            for step in portal.get("timings", []):
                for suffix in (".json", ".stdout", ".stderr"):
                    if f"portal/{step['id']}{suffix}" not in meta.get("extraArtifacts", {}):
                        failures.append("Portal raw substep output is missing")
    return meta, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("artifacts", "sha", "run-id", "attempt", "job-result"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--mode", choices=("p1", "pf2-h1"), required=True)
    args = parser.parse_args()
    root = Path(args.artifacts)
    failures, records = [], {}
    if args.job_result != "success":
        failures.append(f"Required verification jobs did not all succeed: {args.job_result}")
    modes = ["p1-checks", "p1-core", "p1-portal"] if args.mode == "p1" else ["pf2-h1"]
    expected = {f"{mode}-evidence-{args.sha}-{args.attempt}" for mode in modes}
    if not root.is_dir() or {path.name for path in root.iterdir()} != expected:
        failures.append("Missing or unexpected evidence artifact directories")
    for mode in modes:
        try:
            meta, errors = validate_directory(root / f"{mode}-evidence-{args.sha}-{args.attempt}", mode, args.sha)
            failures.extend(f"{mode}: {error}" for error in errors)
            records[mode.removeprefix("p1-")] = meta
        except Exception as error:
            failures.append(f"{mode}: {error}")
    if args.mode == "p1":
        plan = json.loads(subprocess.check_output(["node", str(Path(__file__).with_name("p1-shard.mjs")), "--plan"], text=True))
        failures.extend(judge_shards(records, plan, args.sha, args.run_id, args.attempt))
    result = {"ok": not failures, "reasonCode": "CI_VERIFIED" if not failures else "CI_INCOMPLETE", "mode": args.mode, "head": args.sha, "failures": failures}
    print(json.dumps(result))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(f"CI evidence: **{result['reasonCode']}**\n\n| Shard | Execution seconds | Tests |\n| --- | ---: | ---: |\n")
            for shard, meta in records.items():
                stream.write(f"| {shard} | {meta.get('elapsedSeconds', 'unknown')} | {meta.get('testTotals', {}).get('tests', 'n/a')} |\n")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
