#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Retain independent CI P1 or explicitly selected PF-2 H1 evidence.

Adaptation of the supplied read-only-descriptor runner and fixture preflight:
paths are CLI inputs; default P1 uses acquired pnpm, H1 preserves Corepack dispatch.
No product command, controller, reaper, test selection, or cleanup is changed.
Exactly one selected invocation; no install, retry, or repair here.
The pf2-h1 mode preserves literal corepack pnpm@11.3.0 ... run test.
Neither mode establishes whole PF-2, dry-run, PF-3, or native acceptance.
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
COREPACK_VERSION = "0.34.6"
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
    label = mode_config(meta.get("mode", "p1"))["label"]
    expected = {f"{label}.{kind}": meta.get(kind) for kind in ("stdout", "stderr")}
    if mode_config(meta.get("mode", "p1"))["controller"]:
        expected.update({f"{label}-controller.{kind}": retained.get(kind) for kind in ("stdout", "stderr")})
    for name in ("fixture-location.json", "source-before.json", "source-after.json"):
        expected[name] = meta.get("artifactFiles", {}).get(name)
    expected.update(meta.get("extraArtifacts", {}))
    for name, record in expected.items():
        try:
            if not isinstance(record, dict) or record.get("file") != name:
                raise Refusal("expected receipt is missing or names another file")
            path = Path(evidence) / name
            if Path(name).is_absolute() or ".." in Path(name).parts or any(p.is_symlink() for p in [path, *path.parents]):
                raise Refusal("unsafe artifact path")
            actual = {**file_receipt(path), "file": name}
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
            "coreTestFiles": core_tests, "coreTestFileCount": len(core_tests),
            "portalTestFiles": [record["path"] for record in records if record["path"].startswith("portal/tests/") and record["path"].endswith(".test.mjs")]}


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

    def retain(self, evidence, label="p1"):
        retained = {
            "method": "read-only descriptors on earliest top-level tcrn-test-controller-* stdout/stderr under TMPDIR; reaper deletion unchanged",
            "observedTopLevelControllerDirs": self.observed_dirs,
            "files": {}, "errors": self.errors,
        }
        for kind, handle in self.held.items():
            try:
                os.lseek(handle["fd"], 0, os.SEEK_SET)
                target = Path(evidence) / f"{label}-controller.{kind}"
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


def capture_process(argv, repo, env, tmpdir, evidence, label="p1"):
    """One child. Also exercised with harmless fixtures, not product probes."""
    observer = ControllerObserver(tmpdir)
    started = time.monotonic()
    record = {"startUtc": utc(), "exitCode": None, "errors": []}
    try:
        with open(Path(evidence) / f"{label}.stdout", "xb") as out, open(Path(evidence) / f"{label}.stderr", "xb") as err:
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
                       "retainedTestControllerOutput": observer.retain(evidence, label)})
        for kind in ("stdout", "stderr"):
            path = Path(evidence) / f"{label}.{kind}"
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
    raise Refusal("Stream is missing its final JSON receipt")


def final_receipt(stdout, stderr):
    found = []
    for name, data in (("stdout", stdout), ("stderr", stderr)):
        try:
            found.append((name, final_p1_receipt(data)))
        except Refusal:
            pass
    if len(found) != 1:
        raise Refusal("Expected one terminal receipt across stdout/stderr; missing or ambiguous")
    return found[0]


def mode_config(mode):
    if mode == "p1":
        return dict(label="p1", script="verify:p1", expected="P1_VERIFIED", receiptKey="finalP1Receipt", controller=True)
    if mode == "pf2-h1":
        return dict(label="h1", script="test", expected="TESTS_VERIFIED", receiptKey="finalH1Receipt", controller=True)
    if mode in ("p1-checks", "p1-core", "p1-portal"):
        return dict(label=mode, script="ci:shard", expected="P1_SHARD_VERIFIED", receiptKey="finalShardReceipt", controller=mode == "p1-core")
    raise Refusal(f"Unsupported verification mode: {mode}")


def command(mode, executable, repo):
    config = mode_config(mode)
    return [executable, *([f"pnpm@{PNPM_VERSION}"] if mode == "pf2-h1" else []),
            "-C", str(repo), "run", config["script"], *([mode.removeprefix("p1-")] if mode.startswith("p1-") else [])]


def filter_leftovers(rows, tmpdir):
    # Original process marks, excluding both the original and adapted observer.
    marks = [str(tmpdir), "tcrn-workflow/scripts/", "tcrn-test-controller", "task.mjs"]
    return [row.strip() for row in rows if any(mark in row for mark in marks)
            and "d1-runner.py" not in row and "p1-evidence.py" not in row and " ps -axo" not in row]


def leftovers(tmpdir):
    rows = checked_output(["ps", "-axo", "pid=,ppid=,pgid=,command="]).splitlines()
    return filter_leftovers(rows, tmpdir)


def evaluate(meta):
    """A zero child exit alone is never enough to make retention green."""
    config = mode_config(meta.get("mode", "p1"))
    failures = list(meta.get("errors", []))
    if meta.get("exitCode") != 0:
        failures.append(f"Verification child did not succeed: {meta.get('exitCode')}")
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
    if config["controller"] and retained.get("errors") != []:
        failures.append("Controller observation/capture errors are present or unrecorded")
    controller_streams = [
        (f"controller.{kind}", retained.get("files", {}).get(kind)) for kind in ("stdout", "stderr")
    ] if config["controller"] else []
    for name, item in [(kind, meta.get(kind)) for kind in ("stdout", "stderr")] + controller_streams:
        if not isinstance(item, dict) or not isinstance(item.get("bytes"), int) or item["bytes"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
            failures.append(f"Missing or invalid retained stream/hash/size: {name}")
    totals = meta.get("testTotals")
    if (config["controller"] or meta.get("mode") == "p1-portal") and (not totals or totals.get("tests", 0) < 1 or totals.get("fail") != 0 or totals.get("cancelled") != 0):
        failures.append("Exact final test totals missing or not passing")
    final = meta.get(config["receiptKey"], {})
    if final.get("ok") is not True or final.get("reasonCode") != config["expected"] or "injected" in final:
        failures.append(f"Final receipt must report {config['expected']}; observed {final.get('reasonCode', 'missing')}")
    if meta.get("mode", "").startswith("p1-"):
        if final.get("shard") != meta["mode"].removeprefix("p1-"):
            failures.append("Shard receipt names the wrong shard")
        if not meta.get("extraArtifacts") or "shard.json" not in meta["extraArtifacts"]:
            failures.append("Shard step evidence is missing")
    if meta.get("mode") == "pf2-h1":
        for key in ("leftoversBefore", "leftoversAfter"):
            if not isinstance(meta.get(key), list) or meta[key]:
                failures.append(f"H1 {key} missing or contains matching processes")
        if final.get("tests") != meta.get("inputManifest", {}).get("coreTestFiles"):
            failures.append("H1 receipt test-file roster differs from the source manifest")
    return failures


def wrapper_exit(child_exit, failures):
    if isinstance(child_exit, int) and child_exit != 0:
        return child_exit if 0 < child_exit <= 255 else min(255, 128 + abs(child_exit))
    return 1 if failures else 0


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("repo", "evidence", "tmp", "device", "node-bin"):
        parser.add_argument(f"--{key}", required=True, help="absolute path; evidence must not exist")
    parser.add_argument("--mode", choices=("p1", "pf2-h1", "p1-checks", "p1-core", "p1-portal"), default="p1")
    return parser.parse_args()


def main():
    args = arguments()
    config = mode_config(args.mode)
    label = config["label"]
    paths = {key: value for key, value in vars(args).items() if key != "mode"}
    if any(not os.path.isabs(value) or os.path.normpath(value) != value for value in paths.values()):
        raise Refusal("All CLI paths must be absolute and normalized")
    evidence = Path(args.evidence)
    # Atomic exclusive reservation. Never consume or overwrite a previous run.
    evidence.mkdir(mode=0o700)
    meta = {"schemaVersion": "einzbern.ci-p1-evidence.v1", "scope": "independent CI P1; not PF2 or PF3 closure",
            "script": "verify:p1", "cwd": args.repo, "stdin": "/dev/null", "errors": [], "artifactFiles": {},
            "testTotalsScope": "individual tests in earliest top-level core controller; not core test files or Portal tests",
            "adaptation": "already acquired pinned pnpm replaces original corepack dispatch; CLI paths; fail-closed receipt and source manifests added"}
    meta.update({"mode": args.mode, "label": label, "script": config["script"]})
    if args.mode == "pf2-h1":
        meta.update({"schemaVersion": "einzbern.pf2-h1-evidence.v1",
                     "scope": "PF-2 H1 only; not whole PF-2, dry-run, PF-3 or native acceptance",
                     "adaptation": "CLI paths; literal Corepack command; original process observations; fail-closed child, receipt and manifest verification added"})
    env = dict(os.environ)
    env.update({"PATH": args.node_bin + os.pathsep + env.get("PATH", ""),
                "TMPDIR": args.tmp, "COREPACK_ENABLE_NETWORK": "0",
                "EINZBERN_TEST_DEVICE_ROOT": args.device,
                "EINZBERN_HOME": str(Path(args.device) / "einzbern"), "TCRN_OFFLINE_PROOF": "1"})
    if args.mode.startswith("p1-"):
        env.update({"HOME": str(Path(args.device) / "home"),
                    "EINZBERN_CI_EVIDENCE_DIR": str(evidence),
                    "EINZBERN_PORTAL_EVIDENCE_DIR": str(evidence / "portal"),
                    "EINZBERN_PRIVACY_HISTORY_BASE": ""})
        meta["schemaVersion"] = "einzbern.ci-shard-evidence.v1"
        meta["ciIdentity"] = {key: os.environ.get(key) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")}
        meta["testTotalsScope"] = "Portal functional tests" if args.mode == "p1-portal" else ("core controller" if config["controller"] else "not applicable")
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
        if args.mode.startswith("p1-"):
            Path(env["HOME"]).mkdir()
        git_dir = repo / ".git"
        if git_dir.is_symlink() or not git_dir.is_dir():
            raise Refusal("Repository requires a full .git directory, not a linked worktree")
        meta["input"] = identity(repo)
        if meta["input"]["statusPorcelainAll"]:
            raise Refusal("Repository must be clean before verification")
        tool = "corepack" if args.mode == "pf2-h1" else "pnpm"
        pnpm = shutil.which(tool, path=env["PATH"])
        if pnpm is None:
            raise Refusal("Already acquired package manager is not on PATH; no acquisition is performed")
        meta["nodeVersion"] = checked_output([str(node), "--version"], env=env).strip()
        if args.mode == "pf2-h1":
            meta["corepackVersion"] = checked_output([pnpm, "--version"], env=env).strip()
            meta["corepackRealpath"] = os.path.realpath(pnpm)
            if meta["corepackVersion"] != COREPACK_VERSION:
                raise Refusal(f"Pinned Corepack {COREPACK_VERSION} required at {meta['corepackRealpath']}")
        meta["pnpmVersion"] = checked_output([pnpm, *([f"pnpm@{PNPM_VERSION}"] if args.mode == "pf2-h1" else []), "--version"], env=env).strip()
        if meta["nodeVersion"] != NODE_VERSION or meta["pnpmVersion"] != PNPM_VERSION:
            raise Refusal(f"Pinned versions required: Node {NODE_VERSION}, pnpm {PNPM_VERSION}")
        meta["corepackRealpath" if args.mode == "pf2-h1" else "pnpmRealpath"] = os.path.realpath(pnpm)
        meta["argv"] = command(args.mode, pnpm, args.repo)
        if args.mode == "pf2-h1":
            meta["argvLiteral"] = "corepack pnpm@11.3.0 -C <E> run test"
        meta["inputManifest"] = source_manifest(repo, node, env)
        write_json(evidence / "source-before.json", meta["inputManifest"])
        meta["artifactFiles"]["source-before.json"] = file_receipt(evidence / "source-before.json")
        meta["tmpdirEntriesBefore"] = sorted(os.listdir(args.tmp))
        if args.mode == "pf2-h1":
            meta["leftoversBefore"] = leftovers(args.tmp)
            if meta["leftoversBefore"]:
                raise Refusal("H1 refuses pre-existing matching processes")
        attempted = True
        meta.update(capture_process(meta["argv"], repo, env, args.tmp, evidence, label))
    except Exception as error:  # Preserve an actionable receipt for preflight and run errors.
        meta["errors"].append(str(error))
    finally:
        if attempted and args.mode == "pf2-h1":
            try:
                time.sleep(1.0)  # Original post-child observation interval, not a retry.
                meta["leftoversAfter"] = leftovers(args.tmp)
            except Exception as error:
                meta["errors"].append(f"Process observation: {error}")
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
                if config["controller"]:
                    meta["testTotals"] = parse_test_totals((evidence / f"{label}-controller.stdout").read_bytes())
                elif args.mode == "p1-portal":
                    meta["testTotals"] = parse_test_totals((evidence / "portal" / "01.stdout").read_bytes())
            except Exception as error:
                meta["errors"].append(f"Final controller totals: {error}")
            try:
                meta["finalReceiptStream"], meta[config["receiptKey"]] = final_receipt(
                    (evidence / f"{label}.stdout").read_bytes(), (evidence / f"{label}.stderr").read_bytes())
            except Exception as error:
                meta["errors"].append(f"Final receipt: {error}")
    meta["outputMatchesInput"] = "input" in meta and meta.get("output") == meta["input"]
    meta["sourceManifestMatchesInput"] = "inputManifest" in meta and meta.get("outputManifest") == meta["inputManifest"]
    if args.mode.startswith("p1-"):
        meta["extraArtifacts"] = {}
        try:
            for path in sorted(evidence.rglob("*")):
                name = path.relative_to(evidence).as_posix()
                if path.is_file() and (name == "shard.json" or name.startswith(("steps/", "portal/"))):
                    meta["extraArtifacts"][name] = {**file_receipt(path), "file": name}
        except Exception as error:
            meta["errors"].append(f"Shard artifacts: {error}")
    artifact_failures = verify_retained_artifacts(evidence, meta)
    meta["retainedArtifactsVerified"] = not artifact_failures
    meta["errors"].extend(artifact_failures)
    failures = evaluate(meta)
    status = wrapper_exit(meta.get("exitCode"), failures)
    prefix = "PF2_H1" if args.mode == "pf2-h1" else "CI_P1"
    receipt = {"ok": status == 0, "reasonCode": prefix + ("_EVIDENCE_RETAINED" if status == 0 else "_EVIDENCE_REFUSED"),
               "evidence": str(evidence), "childExitCode": meta.get("exitCode"), "wrapperExitCode": status,
               "coreTestFileCount": meta.get("inputManifest", {}).get("coreTestFileCount"),
               "testTotals": meta.get("testTotals"), "failures": failures,
               "nextAction": None if status == 0 else f"Inspect {label}.meta.json and retained streams; do not treat missing evidence as a pass or retry this directory."}
    meta["receipt"] = receipt
    write_json(evidence / f"{label}.meta.json", meta)
    write_json(evidence / "receipt.json", receipt)
    print(json.dumps(receipt))
    return status


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, Refusal) as error:
        print(json.dumps({"ok": False, "reasonCode": "CI_P1_EVIDENCE_REFUSED", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
