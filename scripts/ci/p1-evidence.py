#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Retain independent CI P1 evidence, not PF2/PF3 closure evidence.

Adaptation of the supplied read-only-descriptor runner and fixture preflight:
paths are CLI inputs and CI's already acquired pnpm replaces corepack dispatch.
No product command, controller, reaper, test selection, or cleanup is changed.
Exactly one verify:p1 invocation; no install, build, retry, or repair here.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

NODE_VERSION = "v24.16.0"
PNPM_VERSION = "11.3.0"
# Do not serialize the inherited environment (including its key names). These
# operational values are the entire metadata allowlist, not a redaction denylist.
ENVIRONMENT_KEYS = (
    "PATH", "TMPDIR", "COREPACK_ENABLE_NETWORK", "CI", "EINZBERN_HOME",
    "TCRN_OFFLINE_PROOF", "EINZBERN_TEST_DEVICE_ROOT", "EINZBERN_PRIVACY_HISTORY_BASE",
)
MANIFEST_SCRIPT = """
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const { walkFiles, fileRecord } = await import(pathToFileURL(`${root}/scripts/lib/files.mjs`));
const records = [];
for (const path of await walkFiles(root)) records.push(await fileRecord(path, root));
process.stdout.write(JSON.stringify(records));
"""


class Refusal(RuntimeError):
    pass


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    with open(path, "x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=True) + "\n")


def file_receipt(path):
    digest = hashlib.sha256()
    size = 0
    before = os.lstat(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise Refusal(f"Evidence must be a bound, singly linked regular file: {path}")
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
        after = os.fstat(stream.fileno())
    current = os.lstat(path)
    def signature(value):
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if signature(opened) != signature(after) or signature(after) != signature(current) or size != after.st_size:
        raise Refusal(f"Evidence changed while hashing: {path}")
    return {"file": Path(path).name, "bytes": size, "sha256": digest.hexdigest()}


def verify_retained_artifacts(evidence, meta):
    """Reread every required artifact; matching metadata shapes are insufficient."""
    failures = []
    verified = set()
    retained = meta.get("retainedTestControllerOutput", {}).get("files", {})
    expected = {f"p1.{kind}": meta.get(kind) for kind in ("stdout", "stderr")}
    expected.update({f"p1-controller.{kind}": retained.get(kind) for kind in ("stdout", "stderr")})
    for name in ("fixture-location.json", "source-before.json", "source-after.json"):
        expected[name] = meta.get("artifactFiles", {}).get(name)
    for name, record in expected.items():
        try:
            if not isinstance(record, dict) or record.get("file") != name:
                raise Refusal("expected receipt is missing or names another file")
            actual = file_receipt(Path(evidence) / name)
            if any(actual[key] != record.get(key) for key in ("file", "bytes", "sha256")):
                raise Refusal("retained bytes do not match their recorded SHA-256 and size")
            verified.add(name)
        except Exception as error:
            failures.append(f"Artifact {name}: {error}")
    for name, key in (("fixture-location.json", "fixtures"), ("source-before.json", "inputManifest"), ("source-after.json", "outputManifest")):
        if name not in verified:
            continue
        try:
            fd = os.open(Path(evidence) / name, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "r", encoding="utf-8") as stream:
                if json.load(stream) != meta.get(key):
                    raise Refusal("retained JSON does not match its metadata record")
        except Exception as error:
            failures.append(f"Artifact {name}: {error}")
    return failures


def fixture_checks_pass(checks):
    """Pure predicate; tests may inject metadata, never bypass the CLI preflight."""
    return (
        checks["realpathEqual"] and checks["isDirectoryNotSymlink"]
        and checks["uidMatchesProcess"] and not checks["symlinksOnPath"]
        and not checks["gitAncestors"] and checks["gitRevParseExit"] != 0
    )


def fixture_location(path):
    """Preserve all original fixture checks; a broken .git link also refuses."""
    path = str(path)
    p = Path(path)
    metadata = os.lstat(path)
    parents = [p, *p.parents]
    links = [str(q) for q in parents if q.is_symlink()]
    gits = [str(q) for q in parents if os.path.lexists(q / ".git")]
    probe = subprocess.run(
        ["git", "-C", path, "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=False,
    )
    checks = {
        "realpathEqual": os.path.realpath(path) == path,
        "isDirectoryNotSymlink": stat.S_ISDIR(metadata.st_mode) and not p.is_symlink(),
        "uid": metadata.st_uid,
        "uidMatchesProcess": metadata.st_uid == os.getuid(),
        "mode": oct(metadata.st_mode & 0o777),
        "symlinksOnPath": links,
        "gitAncestors": gits,
        "gitRevParseExit": probe.returncode,
        "pathBytes": len(os.fsencode(path)),
        "entriesAtRecord": sorted(os.listdir(path)) if p.is_dir() else None,
    }
    return {"path": path, "createdUtc": utc(), "checks": checks,
            "checksPassed": fixture_checks_pass(checks)}


def checked_output(argv, *, cwd=None, env=None):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise Refusal(f"Command failed ({result.returncode}): {argv[0]} {argv[1:]}; {result.stderr.strip()}")
    return result.stdout


def identity(repo):
    def git(*args):
        return checked_output(["git", "--no-optional-locks", "-C", str(repo), *args])
    head = git("rev-parse", "HEAD").strip()
    tree = git("rev-parse", "HEAD^{tree}").strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", head) or not re.fullmatch(r"[0-9a-f]{40,64}", tree):
        raise Refusal("Repository HEAD/tree identity is missing or invalid")
    return {"head": head, "tree": tree,
            "branch": git("rev-parse", "--abbrev-ref", "HEAD").strip(),
            "statusPorcelainAll": git("status", "--porcelain=v1", "--untracked-files=all")}


def source_manifest(repo, node, env):
    # Both snapshots use the actual repository helper's entire roster and its
    # bound regular-file reads, including its canonical ordering and exclusions.
    records = json.loads(checked_output(
        [str(node), "--input-type=module", "--eval", MANIFEST_SCRIPT, str(repo)],
        cwd=repo, env=env,
    ))
    if not isinstance(records, list) or not records:
        raise Refusal("Source walk returned no file manifest")
    # This is the same filename predicate as runTests, not a number of individual
    # test cases or any of Portal's independently counted tests.
    core_tests = [record["path"] for record in records
                  if record["path"].startswith("tests/") and record["path"].endswith(".test.mjs")]
    if not core_tests:
        raise Refusal("Source walk returned no core test-file roster")
    return {"method": "scripts/lib/files.mjs walkFiles + fileRecord", "files": records,
            "coreTestFiles": core_tests, "coreTestFileCount": len(core_tests)}


class ControllerObserver:
    """Original earliest-controller read-only FD capture; no reaper intervention."""

    def __init__(self, tmpdir):
        self.tmpdir = str(tmpdir)
        self.held = {}
        self.observed_dirs = []
        self.errors = []

    def observe(self):
        try:
            with os.scandir(self.tmpdir) as scanner:
                entries = list(scanner)
            for entry in entries:
                if not entry.name.startswith("tcrn-test-controller-") or not entry.is_dir(follow_symlinks=False):
                    continue
                if entry.path not in [d["path"] for d in self.observed_dirs]:
                    self.observed_dirs.append({
                        "path": entry.path, "firstObservedUtc": utc(),
                        "birthtime": getattr(entry.stat(follow_symlinks=False), "st_birthtime", None),
                    })
            if not self.observed_dirs:
                return
            first = min(self.observed_dirs, key=lambda d: (d["birthtime"] or 0, d["firstObservedUtc"]))
            for kind in ("stdout", "stderr"):
                if kind in self.held:
                    continue
                source = os.path.join(first["path"], kind)
                try:
                    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        os.close(fd)
                        raise Refusal("Controller output is not a regular file")
                    self.held[kind] = {"fd": fd, "dir": first["path"], "openedUtc": utc()}
                except FileNotFoundError:
                    pass
                except (OSError, Refusal) as error:
                    self.errors.append({"at": utc(), "path": source, "error": str(error)})
        except OSError as error:
            self.errors.append({"at": utc(), "error": str(error)})

    def retain(self, evidence):
        retained = {
            "method": "read-only descriptors on earliest top-level tcrn-test-controller-* stdout/stderr under TMPDIR; reaper deletion unchanged",
            "observedTopLevelControllerDirs": self.observed_dirs,
            "files": {}, "errors": self.errors,
        }
        for kind, handle in self.held.items():
            try:
                os.lseek(handle["fd"], 0, os.SEEK_SET)
                target = Path(evidence) / f"p1-controller.{kind}"
                with open(target, "xb") as stream:
                    while chunk := os.read(handle["fd"], 1 << 20):
                        stream.write(chunk)
                retained["files"][kind] = {
                    **file_receipt(target), "sourceDirectory": handle["dir"],
                    "openedUtc": handle["openedUtc"],
                }
            except Exception as error:  # Capture failures are evidence failures, never hidden.
                retained["errors"].append({"kind": kind, "error": str(error)})
            finally:
                os.close(handle["fd"])
        self.held.clear()
        return retained


def capture_process(argv, repo, env, tmpdir, evidence):
    """One child. Also exercised with harmless fixtures, not product probes."""
    observer = ControllerObserver(tmpdir)
    started = time.monotonic()
    record = {"startUtc": utc(), "exitCode": None, "errors": []}
    try:
        with open(Path(evidence) / "p1.stdout", "xb") as out, open(Path(evidence) / "p1.stderr", "xb") as err:
            process = subprocess.Popen(
                argv, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                stdout=out, stderr=err, start_new_session=True,
            )
            last_scan = 0.0
            while process.poll() is None:
                now = time.monotonic()
                if len(observer.held) < 2 or now - last_scan >= 1.0:
                    observer.observe()
                    last_scan = now
                time.sleep(0.025)
            record["exitCode"] = process.wait()
            observer.observe()
    except Exception as error:
        record["errors"].append(f"Child capture: {error}")
    finally:
        record.update({"endUtc": utc(), "elapsedSeconds": time.monotonic() - started,
                       "retainedTestControllerOutput": observer.retain(evidence)})
        for kind in ("stdout", "stderr"):
            path = Path(evidence) / f"p1.{kind}"
            try:
                record[kind] = file_receipt(path)
            except Exception as error:
                record["errors"].append(f"Outer {kind}: {error}")
    return record


def parse_test_totals(data):
    """Only a unique, complete Node spec/TAP summary, never estimated counts."""
    text = data.decode("utf-8", errors="strict")
    text = re.sub(r"\x1b\[[0-9;]*m", "", text).replace("\r\n", "\n")
    keys = ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo")
    headers = list(re.finditer(r"^(#|ℹ) tests (\d+)$", text, flags=re.MULTILINE))
    if len(headers) != 1:
        raise Refusal("Controller must contain exactly one final Node spec/TAP test summary")
    header = headers[0]
    prefix = re.escape(header.group(1))
    pattern = "\n".join(rf"{prefix} {key} (?P<{key}>\d+)" for key in keys)
    pattern += rf"\n{prefix} duration_ms (?P<duration_ms>\d+(?:\.\d+)?)(?:\n|$)"
    match = re.match(pattern, text[header.start():])
    if match is None:
        raise Refusal("Controller final test summary is truncated or unsupported")
    result = {key: int(match.group(key)) for key in keys}
    result.update({"format": "tap" if header.group(1) == "#" else "spec",
                   "durationMs": float(match.group("duration_ms"))})
    if result["tests"] < 1 or result["tests"] != sum(result[key] for key in ("pass", "fail", "cancelled", "skipped", "todo")):
        raise Refusal("Controller final test totals are empty or inconsistent")
    return result


def final_p1_receipt(data):
    text = data.decode("utf-8", errors="strict")
    decoder = json.JSONDecoder()
    for match in re.finditer(r"^\{", text, flags=re.MULTILINE):
        try:
            value, end = decoder.raw_decode(text[match.start():])
        except json.JSONDecodeError:
            continue
        if not text[match.start() + end:].strip() and isinstance(value, dict):
            return value
    raise Refusal("Outer stdout is missing its final P1 JSON receipt")


def evaluate(meta):
    """A zero child exit alone is never enough to make retention green."""
    failures = list(meta.get("errors", []))
    if meta.get("exitCode") != 0:
        failures.append(f"P1 child did not succeed: {meta.get('exitCode')}")
    for name in ("tmp", "device"):
        if meta.get("fixtures", {}).get(name, {}).get("checksPassed") is not True:
            failures.append(f"{name} fixture preflight missing or refused")
    incoming, outgoing = meta.get("input"), meta.get("output")
    if not incoming or not outgoing or incoming != outgoing:
        failures.append("Input/output repository identity missing or changed")
    for record in (incoming, outgoing):
        if not record or any(not re.fullmatch(r"[0-9a-f]{40,64}", record.get(key, "")) for key in ("head", "tree")) or record.get("statusPorcelainAll") != "":
            failures.append("Repository identity is invalid or not clean")
            break
    if not meta.get("inputManifest") or meta.get("inputManifest") != meta.get("outputManifest"):
        failures.append("Input/output source file manifests missing or changed")
    if meta.get("retainedArtifactsVerified") is not True:
        failures.append("Full retained artifact reread/hash/size verification is missing or failed")
    retained = meta.get("retainedTestControllerOutput", {})
    if retained.get("errors") != []:
        failures.append("Controller observation/capture errors are present or unrecorded")
    for name, item in [(kind, meta.get(kind)) for kind in ("stdout", "stderr")] + [
        (f"controller.{kind}", retained.get("files", {}).get(kind)) for kind in ("stdout", "stderr")
    ]:
        if not isinstance(item, dict) or not isinstance(item.get("bytes"), int) or item["bytes"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
            failures.append(f"Missing or invalid retained stream/hash/size: {name}")
    totals = meta.get("testTotals")
    if not totals or totals.get("tests", 0) < 1 or totals.get("fail") != 0 or totals.get("cancelled") != 0:
        failures.append("Exact final test totals missing or not passing")
    final = meta.get("finalP1Receipt", {})
    if final.get("ok") is not True or final.get("reasonCode") != "P1_VERIFIED" or "injected" in final:
        failures.append("Uninjected final P1_VERIFIED receipt is missing")
    return failures


def wrapper_exit(child_exit, failures):
    if isinstance(child_exit, int) and child_exit != 0:
        return child_exit if 0 < child_exit <= 255 else min(255, 128 + abs(child_exit))
    return 1 if failures else 0


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("repo", "evidence", "tmp", "device", "node-bin"):
        parser.add_argument(f"--{key}", required=True, help="absolute path; evidence must not exist")
    return parser.parse_args()


def main():
    args = arguments()
    paths = vars(args)
    if any(not os.path.isabs(value) or os.path.normpath(value) != value for value in paths.values()):
        raise Refusal("All CLI paths must be absolute and normalized")
    evidence = Path(args.evidence)
    # Atomic exclusive reservation. Never consume or overwrite a previous run.
    evidence.mkdir(mode=0o700)
    meta = {"schemaVersion": "einzbern.ci-p1-evidence.v1", "scope": "independent CI P1; not PF2 or PF3 closure",
            "script": "verify:p1", "cwd": args.repo, "stdin": "/dev/null", "errors": [], "artifactFiles": {},
            "testTotalsScope": "individual tests in earliest top-level core controller; not core test files or Portal tests",
            "adaptation": "already acquired pinned pnpm replaces original corepack dispatch; CLI paths; fail-closed receipt and source manifests added"}
    env = dict(os.environ)
    env.update({"PATH": args.node_bin + os.pathsep + env.get("PATH", ""),
                "TMPDIR": args.tmp, "COREPACK_ENABLE_NETWORK": "0",
                "EINZBERN_TEST_DEVICE_ROOT": args.device,
                "EINZBERN_HOME": str(Path(args.device) / "einzbern"), "TCRN_OFFLINE_PROOF": "1"})
    meta["environment"] = {key: env[key] for key in ENVIRONMENT_KEYS if key in env}
    repo = Path(args.repo)
    node = Path(args.node_bin) / "node"
    attempted = False
    try:
        for left in (args.repo, args.tmp, args.device, args.evidence):
            if os.path.realpath(left) != left:
                raise Refusal(f"Path is not its exact realpath: {left}")
            for right in (args.repo, args.tmp, args.device, args.evidence):
                if left != right and Path(left).is_relative_to(right):
                    raise Refusal("Repository, evidence, tmp, and device roots must be disjoint")
        if len({args.repo, args.tmp, args.device, args.evidence}) != 4:
            raise Refusal("Repository, evidence, tmp, and device roots must differ")
        meta["fixtures"] = {key: fixture_location(getattr(args, key)) for key in ("tmp", "device")}
        write_json(evidence / "fixture-location.json", meta["fixtures"])
        meta["artifactFiles"]["fixture-location.json"] = file_receipt(evidence / "fixture-location.json")
        for name, fixture in meta["fixtures"].items():
            if not fixture["checksPassed"]:
                raise Refusal(f"{name} fixture preflight refused; see fixture-location.json")
            if fixture["checks"]["entriesAtRecord"]:
                raise Refusal(f"{name} fixture must be empty before the single run")
        git_dir = repo / ".git"
        if git_dir.is_symlink() or not git_dir.is_dir():
            raise Refusal("Repository requires a full .git directory, not a linked worktree")
        meta["input"] = identity(repo)
        if meta["input"]["statusPorcelainAll"]:
            raise Refusal("Repository must be clean before P1")
        pnpm = shutil.which("pnpm", path=env["PATH"])
        if pnpm is None:
            raise Refusal("Already acquired pnpm is not on PATH; no acquisition is performed")
        meta["nodeVersion"] = checked_output([str(node), "--version"], env=env).strip()
        meta["pnpmVersion"] = checked_output([pnpm, "--version"], env=env).strip()
        if meta["nodeVersion"] != NODE_VERSION or meta["pnpmVersion"] != PNPM_VERSION:
            raise Refusal(f"Pinned versions required: Node {NODE_VERSION}, pnpm {PNPM_VERSION}")
        meta["pnpmRealpath"] = os.path.realpath(pnpm)
        meta["argv"] = [pnpm, "-C", args.repo, "run", "verify:p1"]
        meta["inputManifest"] = source_manifest(repo, node, env)
        write_json(evidence / "source-before.json", meta["inputManifest"])
        meta["artifactFiles"]["source-before.json"] = file_receipt(evidence / "source-before.json")
        meta["tmpdirEntriesBefore"] = sorted(os.listdir(args.tmp))
        attempted = True
        meta.update(capture_process(meta["argv"], repo, env, args.tmp, evidence))
    except Exception as error:  # Preserve an actionable receipt for preflight and run errors.
        meta["errors"].append(str(error))
    finally:
        if "input" in meta:
            try:
                meta["output"] = identity(repo)
            except Exception as error:
                meta["errors"].append(f"Output identity: {error}")
        if "inputManifest" in meta:
            try:
                meta["outputManifest"] = source_manifest(repo, node, env)
                write_json(evidence / "source-after.json", meta["outputManifest"])
                meta["artifactFiles"]["source-after.json"] = file_receipt(evidence / "source-after.json")
            except Exception as error:
                meta["errors"].append(f"Output manifest: {error}")
        if attempted:
            try:
                meta["tmpdirEntriesAfter"] = sorted(os.listdir(args.tmp))
                meta["testTotals"] = parse_test_totals((evidence / "p1-controller.stdout").read_bytes())
            except Exception as error:
                meta["errors"].append(f"Final controller totals: {error}")
            try:
                meta["finalP1Receipt"] = final_p1_receipt((evidence / "p1.stdout").read_bytes())
            except Exception as error:
                meta["errors"].append(f"Final P1 receipt: {error}")
    meta["outputMatchesInput"] = "input" in meta and meta.get("output") == meta["input"]
    meta["sourceManifestMatchesInput"] = "inputManifest" in meta and meta.get("outputManifest") == meta["inputManifest"]
    artifact_failures = verify_retained_artifacts(evidence, meta)
    meta["retainedArtifactsVerified"] = not artifact_failures
    meta["errors"].extend(artifact_failures)
    failures = evaluate(meta)
    status = wrapper_exit(meta.get("exitCode"), failures)
    receipt = {"ok": status == 0, "reasonCode": "CI_P1_EVIDENCE_RETAINED" if status == 0 else "CI_P1_EVIDENCE_REFUSED",
               "evidence": str(evidence), "childExitCode": meta.get("exitCode"), "wrapperExitCode": status,
               "coreTestFileCount": meta.get("inputManifest", {}).get("coreTestFileCount"),
               "testTotals": meta.get("testTotals"), "failures": failures,
               "nextAction": None if status == 0 else "Inspect p1.meta.json and retained streams; do not treat missing evidence as a pass or retry this directory."}
    meta["receipt"] = receipt
    write_json(evidence / "p1.meta.json", meta)
    write_json(evidence / "receipt.json", receipt)
    print(json.dumps(receipt))
    return status


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, Refusal) as error:
        print(json.dumps({"ok": False, "reasonCode": "CI_P1_EVIDENCE_REFUSED", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
