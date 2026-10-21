#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Fail closed unless every expected shard retained passing evidence for this run."""
import hashlib
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
        if meta.get("ciIdentity") != {"GITHUB_RUN_ID": run_id, "GITHUB_RUN_ATTEMPT": attempt, "GITHUB_JOB": "p1"}:
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
    totals_path = directory / f"{config['label']}-controller.stdout" if config["controller"] else directory / "portal/01.stdout"
    if (config["controller"] or mode == "p1-portal") and evidence_runner.parse_test_totals(totals_path.read_bytes()) != meta.get("testTotals"):
        failures.append("Test totals differ from retained raw output")
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
            if "impactPlan" in meta:
                step = json.loads((directory / "steps/leg-test.json").read_text())
                command = step.get("command", [])
                if len(command) != 5 or command[:4] != ["node", "scripts/task.mjs", "test", "--ci-plan"]:
                    failures.append("Core explicit selected-plan argv missing")
                if core.get("argv") != ["--test", *meta["selectedCoreTests"]] or core.get("planDigest") != meta.get("planDigest") or core.get("coverage") != meta.get("coverage"):
                    failures.append("Core controller argv/coverage/plan mismatch")
                if core.get("reasonCode") != ("TESTS_VERIFIED" if meta["coverage"] == "full" else "TESTS_SELECTED_VERIFIED"):
                    failures.append("Core coverage reason mismatch")
            if core.get("tests") != meta.get("selectedCoreTests", meta.get("inputManifest", {}).get("coreTestFiles")):
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


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def validate_plan_shape(plan, sha, run_id, attempt):
    failures = []
    semantic = {key: value for key, value in plan.items() if key != "planDigest"}
    if canonical_digest(semantic) != plan.get("planDigest"):
        failures.append("Canonical plan digest mismatch")
    if plan.get("head") != sha or plan.get("runId") != run_id or plan.get("attempt") != attempt:
        failures.append("Plan SHA/run/attempt mismatch")
    if plan.get("coverage") not in ("full", "selective"):
        failures.append("Unknown plan coverage")
    if list(plan.get("shards", {})) != (["checks", "core", "portal"] if plan.get("portalTests") else ["checks", "core"]):
        failures.append("Plan shard roster malformed")
    for key in ("sourceCoreTests", "sourcePortalTests", "coreTests", "portalTests"):
        values = plan.get(key)
        if not isinstance(values, list) or values != sorted(set(values)):
            failures.append(f"{key}: duplicate or unordered roster")
    if plan.get("coverage") == "full" and (plan.get("coreTests") != plan.get("sourceCoreTests") or plan.get("portalTests") != plan.get("sourcePortalTests") or plan.get("notApplicable") != []):
        failures.append("Full coverage omits source tests")
    return failures


def validate_package(directory, plan):
    # Verify every retained package byte after download, as well as the actual
    # installer/setup/doctor outcomes. The producer seals only after smoke succeeds.
    seal = json.loads((directory / "package-seal.json").read_text())
    expected_identity = {key: plan[key] for key in ("head", "runId", "attempt", "planDigest")}
    if seal.get("identity") != expected_identity:
        raise ValueError("Package smoke identity mismatch")
    files = {path.relative_to(directory).as_posix(): path for path in directory.rglob("*") if path.is_file() and path.name != "package-seal.json"}
    if set(files) != set(seal.get("files", {})):
        raise ValueError("Package smoke file set mismatch")
    for name, path in files.items():
        if path.is_symlink() or any(part.is_symlink() for part in path.parents if part != directory.parent):
            raise ValueError("Package symlink")
        content = path.read_bytes()
        if seal["files"][name] != {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}:
            raise ValueError("Package smoke bytes changed")
    if (directory / "source-head.txt").read_text().strip() != plan["head"]:
        raise ValueError("Package source mismatch")
    for name, reason in (("install.json", "INSTALL_ENGINE_READY"), ("setup-plan.json", "SETUP_PLAN_READY"), ("setup-applied.json", "SETUP_APPLIED"), ("doctor.json", "DOCTOR_READY"), ("init.json", "LIBRARY_CREATED"), ("status.json", "WORKSPACE_COMMAND_COMPLETED"), ("commands.json", "CLI_CATALOG_READY")):
        value = json.loads((directory / name).read_text())
        if value.get("reasonCode") != reason:
            raise ValueError(f"Package smoke {name} failed")
    doctor = json.loads((directory / "doctor.json").read_text())
    if doctor.get("ok") is not True or not doctor.get("checks") or not all(row.get("ok") for row in doctor["checks"]):
        raise ValueError("Installed doctor failed")
    archives = list(directory.glob("*.tar.gz"))
    if len(archives) != 1 or (directory / (archives[0].name + ".sha256")).read_text().split()[0] != hashlib.sha256(archives[0].read_bytes()).hexdigest():
        raise ValueError("Release archive digest mismatch")


def git_source_files(repo, sha):
    listing = subprocess.check_output(["git", "-C", str(repo), "ls-tree", "-rz", sha]).split(b"\0")
    entries = []
    for row in listing:
        if not row:
            continue
        header, path = row.split(b"\t", 1)
        mode, kind, oid = header.split()
        name = path.decode("utf-8")
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError("Non-regular Git source")
        if any(part in (".git", ".pnpm-store", "coverage", "dist", "node_modules", ".codex") for part in name.split("/")):
            continue
        entries.append((name, oid))
    request = b"".join(oid + b"\n" for _, oid in entries)
    result = subprocess.run(["git", "-C", str(repo), "cat-file", "--batch"], input=request, capture_output=True, check=True).stdout
    records, offset = [], 0
    for name, oid in entries:
        end = result.index(b"\n", offset)
        actual_oid, kind, size = result[offset:end].split()
        size = int(size)
        if actual_oid != oid or kind != b"blob":
            raise ValueError("Git source object mismatch")
        content = result[end + 1:end + 1 + size]
        if len(content) != size or result[end + 1 + size:end + 2 + size] != b"\n":
            raise ValueError("Git source truncated")
        records.append({"path": name, "size": size, "sha256": hashlib.sha256(content).hexdigest()})
        offset = end + 2 + size
    return sorted(records, key=lambda record: record["path"])


def validate_bundle(root, sha, run_id, attempt, repo, remote=True):
    plan_directory = root / f"plan-evidence-{sha}-{attempt}"
    plan_path = plan_directory / "impact-plan.json"
    plan = json.loads(plan_path.read_text())
    failures = validate_plan_shape(plan, sha, run_id, attempt)
    if remote:
        result = subprocess.run(["node", str(repo / "scripts/ci/impact-plan.mjs"), "validate-remote", str(plan_path)], cwd=repo, capture_output=True, text=True)
        if result.returncode != 0:
            failures.append("Independent plan/source/baseline verification failed: " + result.stderr)
    transport = subprocess.run(["node", str(repo / "scripts/ci/transport-evidence.mjs"), "verify", str(plan_directory / "transport"), str(plan_path)], capture_output=True, text=True)
    if transport.returncode != 0:
        failures.append("Transport payload/manifest failed: " + transport.stderr)
    expected = {f"p1-{shard}-evidence-{sha}-{attempt}" for shard in plan["shards"]} | {plan_directory.name, f"package-smoke-{sha}-{attempt}"}
    if {path.name for path in root.iterdir()} != expected:
        failures.append("Missing/extra artifact directories")
    if {path.name for path in plan_directory.iterdir()} != {"impact-plan.json", "transport"}:
        failures.append("Unexpected plan artifact entries")
    records = {}
    git_files = git_source_files(repo, sha)
    for shard in plan["shards"]:
        try:
            directory = root / f"p1-{shard}-evidence-{sha}-{attempt}"
            meta, errors = validate_directory(directory, f"p1-{shard}", sha)
            failures.extend(f"{shard}: {error}" for error in errors)
            if not meta.get("artifactFiles", {}).get("impact-plan.json") or meta.get("impactPlan") != plan or json.loads((directory / "impact-plan.json").read_text()) != plan:
                failures.append(f"{shard}: missing or altered plan")
            if meta.get("selectedCoreTests") != plan["coreTests"]:
                failures.append(f"{shard}: selected core roster mismatch")
            if meta.get("input", {}).get("tree") != plan["tree"]:
                failures.append(f"{shard}: tree mismatch")
            if sorted(meta.get("inputManifest", {}).get("files", []), key=lambda row: row["path"]) != git_files:
                failures.append(f"{shard}: source manifest bytes differ from Git")
            records[shard] = meta
        except Exception as error:
            failures.append(f"{shard}: {error}")
    failures.extend(judge_shards(records, plan, sha, run_id, attempt))
    try:
        validate_package(root / f"package-smoke-{sha}-{attempt}", plan)
    except Exception as error:
        failures.append(f"Package smoke: {error}")
    return plan, failures, records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("sha", "run-id", "attempt"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--artifacts")
    parser.add_argument("--baseline-artifacts")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--job-result")
    parser.add_argument("--plan-result")
    parser.add_argument("--mode", choices=("p1", "pf2-h1"), default="p1")
    args = parser.parse_args()
    root = Path(args.baseline_artifacts or args.artifacts)
    failures, records = [], {}
    if args.mode == "p1":
        try:
            plan, failures, records = validate_bundle(root, args.sha, args.run_id, args.attempt, Path(args.repo), remote=not bool(args.baseline_artifacts))
            coverage = plan["coverage"]
            if args.baseline_artifacts:
                # Baseline bytes must match the exact base Git tree, independently
                # of the artifact's own claimed source manifest.
                subprocess.run(["node", str(Path(args.repo) / "scripts/ci/impact-plan.mjs"), "validate-baseline", str(root / f"plan-evidence-{args.sha}-{args.attempt}" / "impact-plan.json")], cwd=args.repo, check=True, capture_output=True)
                tree = subprocess.check_output(["git", "-C", args.repo, "rev-parse", args.sha + "^{tree}"], text=True).strip()
                if plan["tree"] != tree:
                    failures.append("Baseline tree differs from Git")
                source = subprocess.check_output(["git", "-C", args.repo, "ls-tree", "-r", "--name-only", args.sha], text=True).splitlines()
                for key, prefix in (("sourceCoreTests", "tests/"), ("sourcePortalTests", "portal/tests/")):
                    if plan[key] != sorted(path for path in source if path.startswith(prefix) and path.endswith(".test.mjs")):
                        failures.append("Baseline source roster differs from Git")
            elif args.job_result != "success" or args.plan_result != "success":
                failures.append("Plan or selected matrix did not succeed")
        except Exception as error:
            coverage = "unknown"
            failures.append(str(error))
        result = {"ok": not failures, "reasonCode": ("CI_VERIFIED" if coverage == "full" else "CI_SELECTED_VERIFIED") if not failures else "CI_INCOMPLETE", "coverage": coverage, "head": args.sha, "shards": list(plan["shards"]) if "plan" in locals() else [], "failures": failures}
        print(json.dumps(result))
        return 0 if not failures else 1
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
