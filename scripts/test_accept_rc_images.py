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
                stdout = network
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
            elif args[0] == "exec" and args[-1] == acceptance.PROBE:
                variant = created[args[1]][0]
                stdout = json.dumps({"health": {"status": "ok"}, "version": {"version": BASE,
                                    "buildId": "wrong" if failure == "version" else SOURCE, "selfHosted": variant == "selfhost"}})
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
        with tempfile.TemporaryDirectory() as directory, patch.object(acceptance, "docker", side_effect=docker), \
             patch.object(acceptance, "inspect", side_effect=inspect):
            if failure:
                with self.assertRaises(ValueError):
                    acceptance.accept(REPO, BUILT, "CREATE TABLE synthetic_fixture(id int);", Path(directory), POSTGRES)
            else:
                result = acceptance.accept(REPO, BUILT, "CREATE TABLE synthetic_fixture(id int);", Path(directory), POSTGRES)
                self.assertEqual(set(result["web"]), {"selfhost", "prod"})
                self.assertIn("no live transport or arm64 execution", result["connector_scope"])
                self.assertEqual(len(created), 6)
            cleanup = json.loads((Path(directory) / "cleanup.json").read_text())
            self.assertEqual(len(cleanup["containers"]), len(created))
            self.assertEqual(cleanup["network"], network)
        self.assertEqual(set(removed), set(created))
        self.assertIn(("network", "rm", network), calls)
        self.assertFalse(any("build" in call or "push" in call for call in calls))

    def test_disposable_both_web_variants_and_limited_connector(self):
        self.exercise()

    def test_assertion_and_cleanup_failures_never_accept(self):
        for failure in ("fixture", "version", "connector", "cleanup"):
            with self.subTest(failure=failure):
                self.exercise(failure)

    def test_support_digest_and_readiness_are_bounded(self):
        for image in ("postgres:17-alpine", "other/postgres@sha256:" + "4" * 64, ""):
            with self.subTest(image=image), patch.object(acceptance, "docker") as docker:
                with self.assertRaisesRegex(ValueError, "pinned official Postgres"):
                    acceptance.accept(REPO, BUILT, "SQL", Path("unused"), image)
                docker.assert_not_called()
        with patch.object(acceptance.time, "monotonic", side_effect=[0, 91]), \
             patch.object(acceptance.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "90 seconds"):
                acceptance.wait_ready(lambda: None)
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

    def test_workflow_disabled_read_only_and_fixture_shipped(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/rc-acceptance.yml").read_text()
        self.assertIn("default: false", workflow)
        self.assertIn("inputs.enabled && vars.OCTOPUS_RC_ACCEPTANCE_ENABLED == 'true'", workflow)
        self.assertIn("packages: read", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("workflow_run:", workflow)
        self.assertIn("--from-empty --to-schema", workflow)
        dockerfile = (root / "apps/web/Dockerfile").read_text()
        self.assertIn("bun build scripts/rc-acceptance.ts --target=node --outfile=/app/rc-acceptance.mjs", dockerfile)
        self.assertIn("/app/rc-acceptance.mjs ./rc-acceptance.mjs", dockerfile)


if __name__ == "__main__":
    unittest.main()
