"""Offline release contract checks; no Docker daemon, registry, or GitHub calls."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import release_images as release

SOURCE = "a" * 40
BASE = "1.2.14"
REPO = "octopusreview/octopus"
BUILT = {"schema": 1, "source": SOURCE, "version": BASE, "tag": "v1.2.14-rc.1",
         "run_id": 10, "run_attempt": 1,
         "images": {v: "sha256:" + str(i) * 64 for i, v in enumerate(release.VARIANTS, 1)}}


class ReleaseTest(unittest.TestCase):
    def test_versions_and_metadata(self):
        self.assertEqual(release.version("v1.2.14-rc.1"), (BASE, "rc"))
        self.assertEqual(release.version("v1.2.14"), (BASE, "stable"))
        for tag in ("1.2.14", "v1.2.14-rc.0", "v1.2.14-rc.01", "v1.2.14-rc.1/x",
                    "v01.2.14", "v1.2.14+metadata", "v1.2.14\n", "v1.2.14-beta.1"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.version(tag)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "apps/web").mkdir(parents=True)
            for name in ("package.json", "apps/web/package.json"):
                (root / name).write_text(json.dumps({"version": BASE}))
            (root / "CHANGELOG.md").write_text("## [1.2.14] - 2026-09-30\n")
            self.assertEqual(release.metadata(BUILT["tag"], root), {"version": BASE, "lane": "rc"})
            (root / "apps/web/package.json").write_text('{"version":"1.2.13"}')
            with self.assertRaisesRegex(ValueError, "apps/web/package.json"):
                release.metadata(BUILT["tag"], root)
            (root / "apps/web/package.json").write_text(json.dumps({"version": BASE}))
            (root / "CHANGELOG.md").write_text("## [1.2.14-rc.1]\n")
            with self.assertRaisesRegex(ValueError, "CHANGELOG"):
                release.metadata(BUILT["tag"], root)

    def test_receipt_requires_all_variants_and_exact_identity(self):
        release.validate_receipt(BUILT, SOURCE, BASE)
        cases = [{"source": "b" * 40}, {"version": "1.2.13"}, {"tag": "v1.2.14"},
                 {"images": {"selfhost": BUILT["images"]["selfhost"]}},
                 {"images": {**BUILT["images"], "prod": ""}}, {"run_attempt": True}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                release.validate_receipt({**BUILT, **changes}, SOURCE, BASE)

    def test_artifact_provenance_checksum_and_current_attempt(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("receipt.json", json.dumps(BUILT))
        raw = archive.getvalue()
        run = {"path": ".github/workflows/release.yml", "event": "push",
               "head_sha": SOURCE, "status": "completed", "conclusion": "success", "run_attempt": 1}
        artifact = {"name": "rc-images-1", "expired": False, "id": 7,
                    "size_in_bytes": len(raw), "digest": "sha256:" + hashlib.sha256(raw).hexdigest()}
        def read(candidate_run=run, candidate_artifact=artifact):
            with patch.object(release, "api", side_effect=[candidate_run, {"artifacts": [candidate_artifact]}, raw]):
                return release.read_artifact(REPO, 10, "release.yml", "push", SOURCE, "rc-images")
        self.assertEqual(read(), (BUILT, 1))
        for change in ({"head_sha": "b" * 40}, {"conclusion": "failure"}, {"status": "in_progress"},
                       {"path": ".github/workflows/ci.yml"}, {"event": "pull_request"}, {"run_attempt": 2}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                read({**run, **change})
        for change in ({"expired": True}, {"digest": "sha256:" + "0" * 64},
                       {"name": "rc-images-2"}, {"size_in_bytes": 2_000_000}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                read(candidate_artifact={**artifact, **change})

    def test_acceptance_is_disabled_without_producer(self):
        with patch.object(release.Path, "is_file", return_value=False), patch.object(release, "api") as remote:
            with self.assertRaisesRegex(ValueError, "not implemented"):
                release.accepted_images(REPO, 20, SOURCE, BASE)
            remote.assert_not_called()

    def test_acceptance_binds_exact_build_and_tag(self):
        accepted = {**copy.deepcopy(BUILT), "accepted": True}
        def check(receipt=accepted, commit=SOURCE, build=BUILT, attempt=1):
            with patch.object(release.Path, "is_file", return_value=True), \
                 patch.object(release, "read_artifact", side_effect=[(receipt, 1), (build, attempt)]), \
                 patch.object(release, "api", return_value={"sha": commit}):
                return release.accepted_images(REPO, 20, SOURCE, BASE)
        self.assertEqual(check(), BUILT)
        for changes in ({"accepted": False}, {"accepted": "true"}, {"source": "b" * 40},
                        {"images": {**BUILT["images"], "prod": "sha256:" + "9" * 64}},
                        {"run_id": 11}, {"tag": "v1.2.14-rc.2"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                check(receipt={**accepted, **changes})
        with self.assertRaisesRegex(ValueError, "tag moved"):
            check(commit="b" * 40)
        with self.assertRaisesRegex(ValueError, "attempt mismatch"):
            check(attempt=2)

    def test_promotion_preflights_all_and_retags_without_build(self):
        rc = release.image_refs(REPO, "1.2.14-rc.1")
        stable = release.image_refs(REPO, BASE)
        registry = {}
        for variant, ref in rc.items():
            digest = BUILT["images"][variant]
            registry[ref] = digest
            registry[ref.rsplit(":", 1)[0] + "@" + digest] = digest
        writes = []
        def inspect(ref):
            return json.dumps({"digest": registry[ref]}).encode()
        def invoke(command, **kwargs):
            self.assertEqual(command[:4], ["docker", "buildx", "imagetools", "create"])
            self.assertEqual(command[4:6], ["--prefer-index=false", "--tag"])
            target, source = command[6:]
            self.assertIn("@sha256:", source)
            if target.endswith((":latest", ":latest-web", ":latest-engine")):
                for variant in release.VARIANTS:
                    self.assertEqual(registry[stable[variant]], BUILT["images"][variant])
            registry[target] = registry[source]
            writes.append(target)
        with patch.object(release.subprocess, "check_output", side_effect=lambda cmd: inspect(cmd[4])), \
             patch.object(release.subprocess, "run", side_effect=invoke):
            release.promote(REPO, BASE, BUILT)
        self.assertEqual(len(writes), 6)
        self.assertEqual(set(writes[:3]), set(stable.values()))
        registry[rc["forgejo-connector"]] = "sha256:" + "9" * 64
        with patch.object(release, "inspect", side_effect=lambda ref: registry[ref]), \
             patch.object(release, "retag") as write:
            with self.assertRaisesRegex(ValueError, "RC tag digest changed"):
                release.promote(REPO, BASE, BUILT)
            write.assert_not_called()
        with patch.object(release.subprocess, "run"), patch.object(release, "inspect", return_value="wrong"):
            with self.assertRaisesRegex(ValueError, "Retag changed digest"):
                release.retag("source", "target", BUILT["images"]["prod"])

    def test_workflow_lanes_and_no_rc_latest(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text()
        rc_jobs = workflow.split("  selfhost:", 1)[1].split("  rc-receipt:", 1)[0]
        self.assertEqual(rc_jobs.count("if: needs.verify-changelog.outputs.lane == 'rc'"), 3)
        self.assertNotIn(":latest", rc_jobs)
        self.assertEqual(rc_jobs.count("org.opencontainers.image.version=${{ needs.verify-changelog.outputs.version }}"), 3)
        self.assertEqual(rc_jobs.count("NEXT_PUBLIC_APP_VERSION=${{ needs.verify-changelog.outputs.version }}"), 2)
        promotion = workflow.split("  promote:", 1)[1].split("  release:", 1)[0]
        self.assertIn("if: needs.verify-changelog.outputs.lane == 'stable'", promotion)
        self.assertNotIn("build-push-action", promotion)
        self.assertIn("python3 scripts/release_images.py promote", promotion)
        self.assertIn("prerelease: ${{ needs.verify-changelog.outputs.lane == 'rc' }}", workflow)
        self.assertIn("make_latest: ${{ needs.verify-changelog.outputs.lane == 'stable' && 'true' || 'false' }}", workflow)


if __name__ == "__main__":
    unittest.main()
