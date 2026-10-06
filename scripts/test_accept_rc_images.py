"""Offline command-boundary checks. These are not Docker/runtime acceptance."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import accept_rc_images as acceptance
from release_images import image_refs
from test_release_images import BASE, BUILT, REPO, SOURCE

POSTGRES = "docker.io/library/postgres@sha256:" + "4" * 64


class AcceptanceTest(unittest.TestCase):
    def exercise(self, failure=None):
        calls, created, removed = [], {}, []
        identities = {}
        network_identity = {}
        diagnostic_failures = []
        refs = image_refs(REPO, BUILT["tag"][1:])
        images = {ref.rsplit(":", 1)[0] + "@" + BUILT["images"][v]: v for v, ref in refs.items()}
        network = "f" * 64
        def docker(*args, **kwargs):
            calls.append(args)
            stdout, stderr, code = "", "", 0
            if args[:2] == ("image", "inspect"):
                if args[2] == "postgres:17-alpine":
                    stdout = json.dumps([{"RepoDigests": ["postgres@sha256:" + "4" * 64]}])
                else:
                    stdout = json.dumps([{"Config": {"Labels": {"org.opencontainers.image.revision": SOURCE,
                                                       "org.opencontainers.image.version": BASE}}}])
            elif args[:3] == ("buildx", "imagetools", "inspect"):
                if args[-1] == "--raw":
                    stdout = json.dumps({"manifests": [{"platform": {"os": "linux", "architecture": arch}}
                                                       for arch in ("amd64", "arm64")]})
                else:
                    stdout = json.dumps({"os": "linux", "architecture": "arm64" if "arm64" in args[-1] else "amd64",
                                         "config": {"Labels": {"org.opencontainers.image.revision": SOURCE,
                                                               "org.opencontainers.image.version": BASE}}})
            elif args[:2] == ("network", "create"):
                self.assertIn("--internal", args)
                owner = args[args.index("--label") + 1].split("=", 1)
                network_identity.update(id=network, name=args[-1], labels={owner[0]: owner[1]})
                if failure == "foreign-network":
                    network_identity["labels"][owner[0]] = "another-owner"
                if failure in ("network-timeout", "foreign-network"):
                    raise subprocess.TimeoutExpired(args, 120)
                stdout = "invalid-id" if failure == "network-invalid-id" else network
            elif args[0] == "create":
                image = next(a for a in args if a in images or a == POSTGRES)
                self.assertEqual(args[args.index("--platform") + 1], "linux/amd64")
                self.assertIn("--network", args)
                self.assertNotIn("--publish", args)
                self.assertNotIn("--volume", args)
                self.assertNotIn("--env-file", args)
                self.assertNotIn("host", args)
                fixture = "/app/rc-acceptance.mjs" in args
                variant = images.get(image, "postgres")
                if fixture or variant == "forgejo-connector":
                    self.assertEqual(args[args.index("--network") + 1], "none")
                else:
                    self.assertEqual(args[args.index("--network") + 1], network)
                if variant in ("selfhost", "prod") and not fixture:
                    self.assertIn("ENABLE_REVIEW_WORKERS=false", args)
                    self.assertIn("DISABLE_ADMIN_SEED=true", args)
                    self.assertIn("DATABASE_URL=postgresql://octopus:synthetic-rc-only@postgres:5432/octopus_rc", args)
                stdout = f"{len(created) + 1:064x}"
                created[stdout] = (variant, fixture)
                owner = args[args.index("--label") + 1].split("=", 1)
                identities[args[args.index("--name") + 1]] = {"id": stdout, "name": args[args.index("--name") + 1],
                                                           "labels": {owner[0]: owner[1]}}
                if failure == "foreign-container":
                    identities[args[args.index("--name") + 1]]["labels"][owner[0]] = "another-owner"
                if failure in ("container-timeout", "foreign-container"):
                    raise subprocess.TimeoutExpired(args, 120)
                if failure == "container-invalid-id":
                    stdout = "invalid-id"
            elif args[:2] == ("container", "inspect"):
                stdout = json.dumps(identities[args[-1]])
            elif args[:2] == ("network", "inspect"):
                self.assertEqual(args[-1], network_identity["name"])
                stdout = json.dumps(network_identity)
            elif args[:2] == ("start", "--attach"):
                variant, fixture = created[args[-1]]
                if fixture:
                    stdout = json.dumps({"schema": 1, "checks": [] if failure == "fixture" else acceptance.CHECKS})
                else:
                    stderr = "wrong error" if failure == "connector" else "Set OCTOPUS_URL and FORGEJO_URL to HTTPS origins\n"
                    code = 1
            elif args[0] == "inspect":
                stdout = "1" if created[args[-1]][0] == "forgejo-connector" else "0"
            elif args[0] == "exec" and "pg_isready" in args:
                self.assertEqual(args[args.index("-h") + 1], "127.0.0.1")
                self.assertGreater(kwargs["timeout"], 0)
                self.assertLessEqual(kwargs["timeout"], 90)
            elif args[0] == "exec" and args[-1] == acceptance.PROBE:
                variant = created[args[1]][0]
                self.assertGreater(kwargs["timeout"], 0)
                self.assertLessEqual(kwargs["timeout"], 90)
                stdout = json.dumps({"health": {"status": "ok"}, "version": {"version": BASE,
                                    "buildId": "wrong" if failure == "version" else SOURCE, "selfHosted": variant == "selfhost", "server": "excluded-server-field"}})
            elif args[:2] == ("exec", "-i"):
                self.assertEqual(kwargs["input"], "CREATE TABLE synthetic_fixture(id int);")
                self.assertIn("ON_ERROR_STOP=1", args)
            elif args[0] == "rm":
                self.assertIn("--volumes", args)
                self.assertIn(args[-1], created)
                removed.append(args[-1])
                code = 1 if failure == "cleanup" else 0
            return subprocess.CompletedProcess(args, code, stdout, stderr)
        def inspect(ref):
            if "@" in ref:
                return ref.split("@", 1)[1]
            return BUILT["images"][next(v for v, value in refs.items() if value == ref)]
        original_write = Path.write_text
        def write(path, *args, **kwargs):
            if failure == "log-write" and path.name.startswith("container-") and not diagnostic_failures:
                diagnostic_failures.append(path.name)
                raise OSError("Synthetic evidence disk failure")
            return original_write(path, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory, patch.object(acceptance, "docker", side_effect=docker), \
             patch.object(acceptance, "inspect", side_effect=inspect), patch.object(Path, "write_text", write):
            evidence = Path(directory) / "rc-evidence"
            evidence.mkdir()
            if failure:
                schema = Path(directory) / "schema.sql"
                schema.write_text("CREATE TABLE synthetic_fixture(id int);")
                env = {"RC_ACCEPTANCE_ENABLED": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
                       "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": SOURCE, "RC_RUN_ID": "10",
                       "RC_SCHEMA_SQL": str(schema), "POSTGRES_IMAGE": POSTGRES}
                previous = Path.cwd()
                try:
                    os.chdir(directory)
                    with patch.dict(os.environ, env, clear=True), patch.object(acceptance, "rc_build", return_value=BUILT):
                        with self.assertRaises((ValueError, subprocess.TimeoutExpired)) as error:
                            acceptance.main()
                        if failure == "version":
                            detail = str(error.exception).split("observed=", 1)[1]
                            self.assertEqual(json.loads(detail), {"version": BASE, "buildId": "wrong", "selfHosted": True})
                            self.assertNotIn("excluded-server-field", str(error.exception))
                finally:
                    os.chdir(previous)
            else:
                result = acceptance.accept(REPO, BUILT, "CREATE TABLE synthetic_fixture(id int);", evidence, POSTGRES)
                self.assertEqual(set(result["web"]), {"selfhost", "prod"})
                self.assertIn("no live transport or arm64 execution", result["connector_scope"])
                self.assertEqual(len(created), 6)
            cleanup = json.loads((evidence / "cleanup.json").read_text())
            self.assertEqual(len(cleanup["containers"]), len(created))
            if failure == "foreign-network":
                self.assertFalse(cleanup["network"]["removed"])
            else:
                self.assertEqual(cleanup["network"]["id"], network)
            if failure == "log-write":
                self.assertEqual(len(diagnostic_failures), 1)
                self.assertEqual(len(cleanup["diagnostic_errors"]), 1)
            self.assertFalse((evidence / "receipt.json").exists())
        self.assertEqual(set(removed), set() if failure == "foreign-container" else set(created))
        if failure == "foreign-network":
            self.assertNotIn(("network", "rm", network), calls)
        else:
            self.assertIn(("network", "rm", network), calls)
        self.assertEqual(sum(call[:2] == ("network", "create") for call in calls), 1)
        self.assertEqual(sum(call[0] == "create" for call in calls), len(created))
        self.assertFalse(any("build" in call or "push" in call for call in calls))

    def test_disposable_both_web_variants_and_limited_connector(self):
        self.exercise()

    def test_assertion_and_cleanup_failures_never_accept(self):
        for failure in ("fixture", "version", "connector", "cleanup"):
            with self.subTest(failure=failure):
                self.exercise(failure)

    def test_lost_create_acknowledgements_reconcile_without_retry(self):
        for failure in ("network-timeout", "network-invalid-id", "container-timeout", "container-invalid-id",
                        "foreign-network", "foreign-container"):
            with self.subTest(failure=failure):
                self.exercise(failure)

    def test_log_write_failure_cannot_interrupt_owned_removal(self):
        self.exercise("log-write")

    def test_readiness_deadline_and_probe_timeout(self):
        calls = []
        def success(timeout):
            calls.append(timeout)
            return subprocess.CompletedProcess([], 0, "ready", "")
        with patch.object(acceptance.time, "monotonic", side_effect=[0, 2, 2.5]), \
             patch.object(acceptance.time, "sleep") as sleep:
            self.assertEqual(acceptance.wait_ready(success), "ready")
            self.assertEqual(calls, [88])
            sleep.assert_not_called()
        calls.clear()
        with patch.object(acceptance.time, "monotonic", side_effect=[0, 89, 91]), \
             patch.object(acceptance.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "90 seconds"):
                acceptance.wait_ready(success)
            self.assertEqual(calls, [1])
            sleep.assert_not_called()
        with patch.object(acceptance.time, "monotonic", side_effect=[0, 89.5, 89.75, 90]), \
             patch.object(acceptance.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "90 seconds"):
                acceptance.wait_ready(lambda timeout: subprocess.CompletedProcess([], 1, "", ""))
            sleep.assert_called_once_with(0.25)
        with patch.object(acceptance.time, "monotonic", side_effect=[0, 89]):
            def timeout_probe(timeout):
                self.assertEqual(timeout, 1)
                raise subprocess.TimeoutExpired("docker", timeout)
            with self.assertRaisesRegex(ValueError, "90 seconds"):
                acceptance.wait_ready(timeout_probe)

    def test_support_digest_and_readiness_are_bounded(self):
        for image in ("postgres:17-alpine", "other/postgres@sha256:" + "4" * 64, ""):
            with self.subTest(image=image), patch.object(acceptance, "docker") as docker:
                with self.assertRaisesRegex(ValueError, "pinned official Postgres"):
                    acceptance.accept(REPO, BUILT, "SQL", Path("unused"), image)
                docker.assert_not_called()
        with patch.object(acceptance.time, "monotonic", side_effect=[0, 91]), \
             patch.object(acceptance.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "90 seconds"):
                acceptance.wait_ready(lambda timeout: None)
            sleep.assert_not_called()

    def test_disabled_never_reads_artifacts_or_invokes_docker(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(acceptance, "rc_build") as read, \
             patch.object(acceptance, "docker") as docker:
            with self.assertRaisesRegex(ValueError, "disabled"):
                acceptance.main()
            read.assert_not_called()
            docker.assert_not_called()

    def test_receipt_only_after_acceptance_cleanup_and_unchanged_build(self):
        previous = Path.cwd()
        try:
            for changed in (False, True):
                with tempfile.TemporaryDirectory() as directory:
                    os.chdir(directory)
                    Path("schema.sql").write_text("CREATE TABLE synthetic_fixture(id int);")
                    after = copy.deepcopy(BUILT)
                    if changed:
                        after["run_attempt"] = 2
                    env = {"RC_ACCEPTANCE_ENABLED": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
                           "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": SOURCE, "RC_RUN_ID": "10", "RC_SCHEMA_SQL": "schema.sql"}
                    with patch.dict(os.environ, env, clear=True), \
                         patch.object(acceptance, "rc_build", side_effect=[BUILT, after]), \
                         patch.object(acceptance, "accept", return_value={"scope": "synthetic"}):
                        if changed:
                            with self.assertRaisesRegex(ValueError, "changed during acceptance"):
                                acceptance.main()
                            self.assertFalse(Path("rc-evidence/receipt.json").exists())
                        else:
                            acceptance.main()
                            self.assertEqual(json.loads(Path("rc-evidence/receipt.json").read_text()), {**BUILT, "accepted": True})
                    os.chdir(previous)
        finally:
            os.chdir(previous)

    def test_workflow_manual_gate_credentials_and_fixture(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/rc-acceptance.yml").read_text()
        self.assertIn("default: false", workflow)
        self.assertIn("inputs.enabled && vars.OCTOPUS_RC_ACCEPTANCE_ENABLED == 'true'", workflow)
        self.assertIn("packages: read", workflow)
        login = workflow.split("      - uses: docker/login-action@", 1)[1].split("      - name: Accept exact", 1)[0]
        self.assertIn("password: ${{ secrets.GHCR_PAT }}", login)
        self.assertEqual(workflow.count("secrets."), 1)
        self.assertIn("GH_TOKEN: ${{ github.token }}", workflow)
        self.assertNotIn("pull_request", workflow)
        self.assertNotIn("push:", workflow)
        self.assertNotIn("workflow_run:", workflow)
        self.assertIn("--from-empty --to-schema", workflow)
        dockerfile = (root / "apps/web/Dockerfile").read_text()
        self.assertIn("bun build scripts/rc-acceptance.ts --target=node --outfile=/app/rc-acceptance.mjs", dockerfile)
        self.assertIn("/app/rc-acceptance.mjs ./rc-acceptance.mjs", dockerfile)


if __name__ == "__main__":
    unittest.main()
