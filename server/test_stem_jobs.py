"""Run: python -m unittest discover -s server -p 'test_*.py' -v"""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import unittest
import uuid
import numpy as np
import soundfile as sf
from stem_jobs import StemJobs


class DurableStemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="music-editor-stem-tests-")
        self.root = Path(self.temporary.name)
        self.jobs = StemJobs(self.root / "jobs")
        self.managers = [self.jobs]
        output = io.BytesIO()
        samples = np.sin(np.arange(22050 * 2) * 2 * np.pi * 440 / 22050).astype(np.float32) * .1
        sf.write(output, samples, 22050, format="WAV", subtype="PCM_16")
        self.wav = output.getvalue()

    def tearDown(self):
        for manager in self.managers:
            manager.stop()
        self.temporary.cleanup()

    def submit(self, manager=None):
        job = uuid.uuid4().hex
        (manager or self.jobs).submit(job, self.wav, "test.wav", {"backend": "dsp", "quality": "balanced", "stems": "basic"})
        return job

    def settle(self, job, status, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.jobs.tick()
            if self.jobs.get(job)["status"] == status:
                return self.jobs.get(job)
            time.sleep(.05)
        self.fail(f"Did not reach {status}: {self.jobs.get(job)}")

    def test_real_dsp_completes_and_can_be_reopened(self):
        job = self.submit()
        row = self.settle(job, "done")
        result = json.loads(row["result"])
        self.assertEqual(result["sourceHash"], hashlib.sha256(self.wav).hexdigest())
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(len(result["stems"]), 4)
        for stem in result["stems"]:
            audio, rate = sf.read(self.jobs.root / job / row["attempt"] / stem["file"])
            self.assertEqual(rate, 22050)
            self.assertEqual(audio.shape, (44100, 2))
        reopened = StemJobs(self.jobs.root)
        self.managers.append(reopened)
        self.assertEqual(reopened.get(job)["result"], row["result"])

    def test_duplicate_submission_does_not_create_another_job(self):
        job = self.submit()
        again = self.jobs.submit(job, self.wav, "renamed.wav", {"backend": "dsp", "quality": "balanced", "stems": "basic"})
        self.assertEqual(again["attempts"], 0)
        with self.assertRaises(ValueError):
            self.jobs.submit(job, b"different", "x.wav", {})
        first = self.jobs.claim()
        other = StemJobs(self.jobs.root)
        self.managers.append(other)
        self.assertIsNone(other.claim())
        self.assertEqual(first["attempts"], 1)

    def test_cancel_before_upload_is_a_durable_tombstone(self):
        job = uuid.uuid4().hex
        self.jobs.cancel(job)
        row = self.jobs.submit(job, self.wav, "late.wav", {})
        self.assertEqual(row["status"], "cancelled")
        self.assertIsNone(self.jobs.claim())
        self.assertFalse((self.jobs.root / job / "source.audio").exists())

    def test_cancel_running_job_terminates_real_child(self):
        worker = self.root / "slow.py"
        worker.write_text("import time\ntime.sleep(30)\n")
        self.jobs.worker = worker
        job = self.submit()
        self.jobs.tick()
        process = self.jobs.process
        self.assertIsNone(process.poll())
        self.jobs.cancel(job)
        self.jobs.tick()
        self.assertIsNotNone(process.poll())
        self.assertEqual(self.jobs.get(job)["status"], "cancelled")

    def test_expired_lease_is_recovered_and_old_result_is_fenced(self):
        job = self.submit()
        old = self.jobs.claim()
        with self.jobs.connection() as conn:
            conn.execute("UPDATE jobs SET lease_until=0 WHERE id=?", (job,))
        other = StemJobs(self.jobs.root)
        self.managers.append(other)
        recovered = other.claim()
        self.assertNotEqual(old["attempt"], recovered["attempt"])
        self.assertEqual(recovered["attempts"], 2)
        self.jobs._finish(old, {"stems": ["late"]})
        self.assertEqual(other.get(job)["status"], "running")
        self.assertIsNone(other.get(job)["result"])

    def test_worker_exit_without_manifest_fails_instead_of_publishing_partial_files(self):
        worker = self.root / "crash.py"
        worker.write_text("raise SystemExit(3)\n")
        self.jobs.worker = worker
        job = self.submit()
        row = self.settle(job, "failed")
        self.assertIn("without a complete result", row["error"])
        self.assertIsNone(row["result"])

    def test_supervisor_enforces_computation_deadline(self):
        worker = self.root / "slow.py"
        worker.write_text("import time\ntime.sleep(30)\n")
        self.jobs.worker = worker
        self.jobs.timeout_seconds = .1
        job = self.submit()
        row = self.settle(job, "failed")
        self.assertIn("time limit", row["error"])

    def test_invalid_audio_fails_without_stems(self):
        job = uuid.uuid4().hex
        self.jobs.submit(job, b"not audio", "bad.wav", {"backend": "dsp"})
        row = self.settle(job, "failed")
        self.assertIn("Error", row["error"])
        self.assertIsNone(row["result"])

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            self.jobs.get("../../outside")

    def test_retention_removes_only_terminal_job_files_and_keeps_cancel_tombstones(self):
        job = self.submit()
        active = self.submit()
        self.jobs.cancel(job)
        with self.jobs.connection() as conn:
            conn.execute("UPDATE jobs SET updated_at=0 WHERE id=?", (job,))
        self.jobs.purge_expired()
        self.assertFalse((self.jobs.root / job).exists())
        self.assertTrue((self.jobs.root / active / "source.audio").exists())
        self.assertEqual(self.jobs.get(job)["status"], "cancelled")

    def test_orphan_worker_watchdog_exits_when_supervisor_lease_expires(self):
        self.jobs.lease_seconds = .2
        job = self.submit()
        row = self.jobs.claim()
        process = subprocess.Popen([sys.executable, "-c",
            "from pathlib import Path; import sys; from stem_jobs import watch_lease; watch_lease(Path(sys.argv[1]), sys.argv[2], sys.argv[3])",
            str(self.jobs.database), job, row["attempt"]], cwd=Path(__file__).parent,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        try:
            self.assertEqual(process.wait(timeout=5), 2)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
