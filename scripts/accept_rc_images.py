#!/usr/bin/env python3
"""Explicitly enabled, disposable RC acceptance; never uses a deployment stack."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

from release_images import VARIANTS, image_refs, inspect, rc_build, require

CHECKS = ["empty-omitted-patch", "empty-null-patch", "coverage-not-assessment", "budget-refusal",
          "empty-inline", "mixed-inline", "conflicting-evidence"]
PROBE = """(async()=>{
const health=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(2000)});
if(!health.ok)throw Error('unhealthy');
const version=await fetch('http://127.0.0.1:3000/api/version',{signal:AbortSignal.timeout(2000)});
if(!version.ok)throw Error('version unavailable');
console.log(JSON.stringify({health:await health.json(),version:await version.json()}));
})().catch(()=>process.exit(1));"""


def docker(*args, check=True, input=None, timeout=120):
    return subprocess.run(["docker", *args], input=input, capture_output=True, text=True,
                          check=check, timeout=timeout)


def image_labels(reference, source, version):
    info = json.loads(docker("image", "inspect", reference).stdout)[0]
    labels = info["Config"]["Labels"]
    require(labels.get("org.opencontainers.image.revision") == source, "Image revision mismatch")
    require(labels.get("org.opencontainers.image.version") == version, "Image version mismatch")


def wait_ready(check):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        result = check()
        if result.returncode == 0:
            return result.stdout
        time.sleep(1)
    raise ValueError("Isolated container did not become ready within 90 seconds")


def accept(repo, receipt, sql, evidence, postgres):
    require(re.fullmatch(r"docker\.io/library/postgres@sha256:[0-9a-f]{64}", postgres), "A pinned official Postgres digest is required")
    refs = image_refs(repo, receipt["tag"][1:])
    images = {v: refs[v].rsplit(":", 1)[0] + "@" + receipt["images"][v] for v in VARIANTS}
    for variant in VARIANTS:
        require(inspect(refs[variant]) == receipt["images"][variant], f"RC tag changed: {variant}")
        require(inspect(images[variant]) == receipt["images"][variant], f"Digest missing: {variant}")
        docker("pull", "--platform", "linux/amd64", images[variant])
        image_labels(images[variant], receipt["source"], receipt["version"])
    index = json.loads(docker("buildx", "imagetools", "inspect", images["forgejo-connector"], "--raw").stdout)
    platforms = {(m.get("platform", {}).get("os"), m.get("platform", {}).get("architecture"))
                 for m in index.get("manifests", [])}
    require({("linux", "amd64"), ("linux", "arm64")} <= platforms, "Connector index lacks required platforms")
    for arch in ("amd64", "arm64"):
        template = '{{json (index .Image "linux/' + arch + '")}}'
        config = json.loads(docker("buildx", "imagetools", "inspect", images["forgejo-connector"], "--format", template).stdout)
        labels = config["config"]["Labels"]
        require(config["os"] == "linux" and config["architecture"] == arch
                and labels.get("org.opencontainers.image.revision") == receipt["source"]
                and labels.get("org.opencontainers.image.version") == receipt["version"],
                f"Connector platform/source/version mismatch: {arch}")
    docker("pull", "--platform", "linux/amd64", postgres)
    require(inspect(postgres) == postgres.split("@", 1)[1], "Postgres digest mismatch")
    name = "octopus-rc-" + uuid.uuid4().hex
    containers, network = [], None
    result = {"source": receipt["source"], "images": images, "postgres": postgres,
              "schema_sha256": hashlib.sha256(sql.encode()).hexdigest(), "web": {},
              "connector_scope": "amd64 missing-config execution; amd64/arm64 descriptors and labels; no live transport or arm64 execution"}

    def create(image, args=(), options=()):
        cid = docker("create", "--platform", "linux/amd64", "--name", f"{name}-{len(containers)}", *options, image, *args).stdout.strip()
        require(re.fullmatch(r"[0-9a-f]{64}", cid), "Unexpected Docker container ID")
        containers.append(cid)
        return cid

    isolated = ("--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only")
    try:
        network = docker("network", "create", "--internal", name).stdout.strip()
        require(re.fullmatch(r"[0-9a-f]{64}", network), "Unexpected Docker network ID")
        db = create(postgres, options=("--network", network, "--network-alias", "postgres",
                    "-e", "POSTGRES_USER=octopus", "-e", "POSTGRES_PASSWORD=synthetic-rc-only", "-e", "POSTGRES_DB=octopus_rc"))
        docker("start", db)
        wait_ready(lambda: docker("exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "octopus", "-d", "octopus_rc", check=False))
        docker("exec", "-i", db, "psql", "-U", "octopus", "-d", "octopus_rc", "-v", "ON_ERROR_STOP=1", input=sql)
        for variant in ("selfhost", "prod"):
            fixture = create(images[variant], ("node", "/app/rc-acceptance.mjs"), isolated)
            output = docker("start", "--attach", fixture, check=False)
            (evidence / f"{variant}-fixture.log").write_text(output.stdout + output.stderr)
            require(output.returncode == 0 and docker("inspect", "--format", "{{.State.ExitCode}}", fixture).stdout.strip() == "0",
                    f"Image-contained fixture failed: {variant}")
            require(json.loads(output.stdout) == {"schema": 1, "checks": CHECKS}, "Fixture assertions incomplete")
            env = ["DATABASE_URL=postgresql://octopus:synthetic-rc-only@postgres:5432/octopus_rc",
                   "BETTER_AUTH_SECRET=synthetic-rc-only-not-a-production-secret", "BETTER_AUTH_URL=http://localhost:3000",
                   "ENABLE_REVIEW_WORKERS=false", "DISABLE_ADMIN_SEED=true", "SENTRY_DSN=", "NEXT_PUBLIC_SENTRY_DSN="]
            options = ["--network", network, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                       "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"]
            for value in env:
                options += ["-e", value]
            web = create(images[variant], options=options)
            docker("start", web)
            observed = json.loads(wait_ready(lambda: docker("exec", web, "node", "-e", PROBE, check=False)))
            require(observed["health"] == {"status": "ok"}, f"Health mismatch: {variant}")
            version = observed["version"]
            require(version.get("version") == receipt["version"] and version.get("buildId") == receipt["source"]
                    and version.get("selfHosted") is (variant == "selfhost"), f"Version/source/variant mismatch: {variant}")
            result["web"][variant] = observed
            docker("stop", "--time", "10", web)
        connector = create(images["forgejo-connector"], options=isolated)
        output = docker("start", "--attach", connector, check=False)
        (evidence / "connector.log").write_text(output.stdout + output.stderr)
        require(docker("inspect", "--format", "{{.State.ExitCode}}", connector).stdout.strip() == "1"
                and output.stderr.strip() == "Set OCTOPUS_URL and FORGEJO_URL to HTTPS origins",
                "Connector missing-configuration smoke failed")
    finally:
        cleanup = {"containers": [], "network": network, "network_removed": network is None}
        for cid in reversed(containers):
            try:
                log = docker("logs", "--tail", "100", cid, check=False, timeout=15)
                (evidence / f"container-{cid[:12]}.log").write_text(log.stdout + log.stderr)
            except subprocess.SubprocessError:
                pass  # A log timeout must not prevent removal of owned containers.
            try:
                removed = docker("rm", "--force", "--volumes", cid, check=False, timeout=30).returncode == 0
            except subprocess.SubprocessError:
                removed = False
            cleanup["containers"].append({"id": cid, "removed": removed})
        if network:
            try:
                cleanup["network_removed"] = docker("network", "rm", network, check=False, timeout=30).returncode == 0
            except subprocess.SubprocessError:
                cleanup["network_removed"] = False
        (evidence / "cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n")
        require(cleanup["network_removed"] and all(c["removed"] for c in cleanup["containers"]),
                "Isolated resource cleanup failed")

    return result


def main():
    require(os.environ.get("RC_ACCEPTANCE_ENABLED") == "true" and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
            "RC acceptance is disabled; explicit repository enablement and manual dispatch required")
    repo, source, run_id = os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"], os.environ["RC_RUN_ID"]
    receipt = rc_build(repo, run_id, source)
    sql = Path(os.environ["RC_SCHEMA_SQL"]).read_text()
    require(bool(sql.strip()), "Synthetic schema SQL is empty")
    evidence = Path("rc-evidence")
    evidence.mkdir(exist_ok=True)
    require(not (evidence / "receipt.json").exists(), "Refusing stale acceptance receipt")
    result = accept(repo, receipt, sql, evidence, os.environ.get("POSTGRES_IMAGE", ""))
    require(rc_build(repo, run_id, source) == receipt, "RC build or tag changed during acceptance")
    (evidence / "runtime.json").write_text(json.dumps(result, indent=2) + "\n")
    (evidence / "receipt.json").write_text(json.dumps({**receipt, "accepted": True}, indent=2) + "\n")


if __name__ == "__main__":
    main()
