import importlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient


class StemApiTests(unittest.TestCase):
    def test_durable_http_contract_and_completed_downloads(self):
        with tempfile.TemporaryDirectory(prefix="music-editor-api-") as directory:
            with patch.dict(os.environ, {"JOBS_DIR": directory, "STEM_BACKEND": "dsp"}):
                import app as module
                module = importlib.reload(module)
                job = uuid.uuid4().hex
                data = io.BytesIO()
                sf.write(data, .1 * np.sin(np.arange(44100) * 2 * np.pi * 220 / 22050), 22050, format="WAV")
                with TestClient(module.app) as client:
                    self.assertEqual(client.get(f"/api/studio/jobs/{job}").status_code, 404)
                    response = client.put(f"/api/studio/jobs/{job}", files={"file": ("audio.wav", data.getvalue(), "audio/wav")},
                                          data={"options": json.dumps({"backend": "dsp"})})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(client.get(f"/api/studio/jobs/{job}/stems/vocals.wav").status_code, 404)
                    deadline = time.time() + 20
                    while time.time() < deadline:
                        row = client.get(f"/api/studio/jobs/{job}").json()
                        if row["status"] in {"done", "failed"}:
                            break
                        time.sleep(.1)
                    self.assertEqual(row["status"], "done", row)
                    for stem in row["result"]["stems"]:
                        audio = client.get(stem["url"])
                        self.assertEqual(audio.status_code, 200)
                        self.assertTrue(audio.content.startswith(b"RIFF"))
                    self.assertEqual(client.get(f"/api/studio/jobs/{job}/stems/source.audio").status_code, 404)
                    unknown = uuid.uuid4().hex
                    self.assertEqual(client.delete(f"/api/studio/jobs/{unknown}").json()["status"], "cancelled")
                    self.assertEqual(client.get(f"/api/studio/jobs/{unknown}").json()["status"], "cancelled")
                self.assertTrue((Path(directory) / "durable" / "jobs.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
