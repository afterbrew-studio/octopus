#!/usr/bin/env python3
"""RC digest receipts and stable promotion. No image builds or production access."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

VARIANTS = ("selfhost", "prod", "forgejo-connector")
SHA = r"[0-9a-f]{40}"
DIGEST = r"sha256:[0-9a-f]{64}"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def version(tag):
    match = re.fullmatch(r"v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(-rc\.[1-9][0-9]*)?", tag)
    require(match, "Expected vX.Y.Z or vX.Y.Z-rc.N (N > 0)")
    return match[1], "rc" if match[2] else "stable"


def metadata(tag, root=Path(".")):
    base, lane = version(tag)
    for path in ("package.json", "apps/web/package.json"):
        require(json.loads((root / path).read_text())["version"] == base,
                f"{path} must have base version {base}")
    require(re.search(r"^## \[" + re.escape(base) + r"\](?:\s|$)",
                      (root / "CHANGELOG.md").read_text(), re.M),
            f"CHANGELOG.md has no {base} entry")
    return {"version": base, "lane": lane}


def validate_receipt(receipt, source, base):
    require(receipt.get("schema") == 1, "Unknown receipt schema")
    require(re.fullmatch(SHA, source) and receipt.get("source") == source, "Source mismatch")
    require(receipt.get("version") == base, "Version mismatch")
    require(version(receipt.get("tag", "")) == (base, "rc"), "Not this version's RC")
    require(set(receipt.get("images", {})) == set(VARIANTS), "All three variants are required")
    for digest in receipt["images"].values():
        require(isinstance(digest, str) and re.fullmatch(DIGEST, digest), "Missing/invalid image digest")
    for key in ("run_id", "run_attempt"):
        require(type(receipt.get(key)) is int and receipt[key] > 0, f"Invalid {key}")
    return receipt


def api(repo, path, binary=False):
    result = subprocess.check_output(["gh", "api", f"repos/{repo}/{path}"])
    return result if binary else json.loads(result)


def read_artifact(repo, run_id, workflow, event, source, name):
    require(re.fullmatch(r"[1-9][0-9]*", str(run_id)), "Expected numeric Actions run ID")
    run = api(repo, f"actions/runs/{run_id}")
    require(run["path"] == f".github/workflows/{workflow}" and run["event"] == event,
            "Receipt must come from the designated workflow/event")
    require(run["head_sha"] == source and run["status"] == "completed" and run["conclusion"] == "success",
            "Receipt run must have succeeded at the exact source")
    attempt = run["run_attempt"]
    artifacts = api(repo, f"actions/runs/{run_id}/artifacts?per_page=100")
    matches = [a for a in artifacts["artifacts"] if a["name"] == f"{name}-{attempt}" and not a["expired"]]
    require(len(matches) == 1, "Missing or ambiguous current-attempt receipt artifact")
    artifact = matches[0]
    require(artifact["size_in_bytes"] < 1_000_000, "Receipt artifact too large")
    raw = api(repo, f"actions/artifacts/{artifact['id']}/zip", binary=True)
    require(artifact.get("digest") == "sha256:" + hashlib.sha256(raw).hexdigest(),
            "Downloaded artifact checksum mismatch")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        require(archive.namelist() == ["receipt.json"], "Expected only receipt.json")
        require(archive.getinfo("receipt.json").file_size < 100_000, "Receipt too large")
        receipt = json.loads(archive.read("receipt.json"))
    return receipt, attempt


def accepted_images(repo, run_id, source, base):
    # Deliberately unavailable until the isolated acceptance producer is reviewed.
    require(Path(".github/workflows/rc-acceptance.yml").is_file(),
            "Stable promotion disabled: isolated rc-acceptance.yml is not implemented")
    accepted, _ = read_artifact(repo, run_id, "rc-acceptance.yml", "workflow_dispatch",
                               source, "rc-acceptance")
    validate_receipt(accepted, source, base)
    require(accepted.get("accepted") is True, "RC acceptance did not pass")
    built, attempt = read_artifact(repo, accepted["run_id"], "release.yml", "push",
                                  source, "rc-images")
    validate_receipt(built, source, base)
    require(built["run_id"] == accepted["run_id"] and built["run_attempt"] == attempt,
            "Build receipt run/attempt mismatch")
    require({k: v for k, v in accepted.items() if k != "accepted"} == built,
            "Acceptance does not bind the exact RC build receipt")
    require(api(repo, f"commits/{built['tag']}")["sha"] == source, "RC tag moved or source differs")
    return built


def image_refs(repo, tag):
    name = f"ghcr.io/{repo.lower()}"
    return {
        "selfhost": f"{name}-selfhost:{tag}",
        "prod": f"{name}:{tag}-prod",
        "forgejo-connector": f"{name}-selfhost:forgejo-connector-{tag}",
    }


def inspect(reference):
    result = subprocess.check_output([
        "docker", "buildx", "imagetools", "inspect", reference,
        "--format", "{{json .Manifest}}",
    ])
    return json.loads(result)["digest"]


def retag(reference, target, digest):
    subprocess.run(["docker", "buildx", "imagetools", "create", "--prefer-index=false",
                    "--tag", target, reference], check=True)
    require(inspect(target) == digest, f"Retag changed digest: {target}")


def promote(repo, base, receipt):
    rc = image_refs(repo, receipt["tag"][1:])
    stable = image_refs(repo, base)
    sources = {}
    # Validate every variant before any registry write. A skipped hosted build fails.
    for variant in VARIANTS:
        digest = receipt["images"][variant]
        require(inspect(rc[variant]) == digest, f"RC tag digest changed: {variant}")
        sources[variant] = rc[variant].rsplit(":", 1)[0] + "@" + digest
        require(inspect(sources[variant]) == digest, f"Missing accepted digest: {variant}")
    for variant in VARIANTS:
        retag(sources[variant], stable[variant], receipt["images"][variant])
    # All stable tags verified before latest aliases can move.
    name = f"ghcr.io/{repo.lower()}"
    for variant, target in (("selfhost", name + "-selfhost:latest"),
                            ("prod", name + ":latest-web"), ("prod", name + ":latest-engine")):
        retag(sources[variant], target, receipt["images"][variant])


def main():
    command = sys.argv[1]
    tag, source = os.environ["GITHUB_REF_NAME"], os.environ["GITHUB_SHA"]
    meta = metadata(tag)
    if command == "metadata":
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key, value in meta.items():
                output.write(f"{key}={value}\n")
    elif command == "receipt":
        require(meta["lane"] == "rc", "Only RC builds produce receipts")
        receipt = {"schema": 1, "source": source, "version": meta["version"], "tag": tag,
                   "run_id": int(os.environ["GITHUB_RUN_ID"]),
                   "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
                   "images": {v: os.environ.get(v.upper().replace("-", "_") + "_DIGEST", "")
                              for v in VARIANTS}}
        validate_receipt(receipt, source, meta["version"])
        Path("receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    elif command == "promote":
        require(meta["lane"] == "stable", "Only stable tags can promote")
        repo = os.environ["GITHUB_REPOSITORY"]
        receipt = accepted_images(repo, os.environ.get("ACCEPTANCE_RUN_ID", ""), source, meta["version"])
        require(api(repo, f"commits/{tag}")["sha"] == source, "Stable tag moved")
        promote(repo, meta["version"], receipt)
    else:
        raise ValueError("Unknown command")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(f"Release refused: {error}")
