"""Durable, single-worker separation queue. SQLite coordinates service instances.

Each attempt owns a subprocess and output directory. Only a completed manifest
is downloadable. Workers watch their lease and exit if their supervisor dies.
"""
from __future__ import annotations
from contextlib import contextmanager, closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid


def valid_id(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9-]{32,36}", value):
        raise ValueError("Invalid job identifier")
    return value


class StemJobs:
    def __init__(self, root: Path, worker: Path | None = None, lease_seconds: float = 15, timeout_seconds: float = 3600, retention_seconds: float = 604800):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "jobs.sqlite"
        self.worker = worker or Path(__file__).with_name("stem_worker.py")
        self.owner = uuid.uuid4().hex
        self.lease_seconds = lease_seconds
        self.timeout_seconds = timeout_seconds
        self.retention_seconds = retention_seconds
        self.next_cleanup = 0.0
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.process: subprocess.Popen | None = None
        self.active: dict | None = None
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, source_hash TEXT,
                options TEXT, filename TEXT, created_at REAL, updated_at REAL,
                owner TEXT, attempt TEXT, lease_until REAL, attempts INTEGER DEFAULT 0,
                error TEXT, error_code TEXT, result TEXT)""")

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.database, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def get(self, job_id: str) -> dict | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (valid_id(job_id),)).fetchone()
            return dict(row) if row else None

    def submit(self, job_id: str, raw: bytes, filename: str, options: dict) -> dict:
        valid_id(job_id)
        digest = hashlib.sha256(raw).hexdigest()
        encoded = json.dumps(options, sort_keys=True)
        directory = self.root / job_id
        directory.mkdir(exist_ok=True)
        temporary = directory / f"upload-{uuid.uuid4().hex}.tmp"
        temporary.write_bytes(raw)
        try:
            with self.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
                if existing:
                    if existing["status"] != "cancelled" and (existing["source_hash"] != digest or existing["options"] != encoded):
                        raise ValueError("Job identifier already belongs to different audio or options")
                    conn.commit()
                    return dict(existing)
                os.replace(temporary, directory / "source.audio")
                now = time.time()
                conn.execute("INSERT INTO jobs(id,status,source_hash,options,filename,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                             (job_id, "queued", digest, encoded, Path(filename).name, now, now))
                conn.commit()
            return self.get(job_id)
        finally:
            temporary.unlink(missing_ok=True)

    def cancel(self, job_id: str) -> dict:
        # A tombstone prevents an upload already in transit from reviving it.
        valid_id(job_id)
        with self.connection() as conn:
            now = time.time()
            conn.execute("""INSERT INTO jobs(id,status,created_at,updated_at,error_code) VALUES(?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET status='cancelled',lease_until=0,updated_at=excluded.updated_at,error_code='cancelled'
                WHERE jobs.status != 'done'""", (job_id, "cancelled", now, now, "cancelled"))
        return self.get(job_id)

    def claim(self) -> dict | None:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            now = time.time()
            conn.execute("""UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
                owner=NULL,lease_until=0,error='Separation supervisor was interrupted',error_code='interrupted',updated_at=?
                WHERE status='running' AND lease_until<=?""", (now, now))
            # One expensive separator at a time, even across service instances.
            if conn.execute("SELECT 1 FROM jobs WHERE status='running'").fetchone():
                conn.commit()
                return None
            row = conn.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").fetchone()
            if not row:
                conn.commit()
                return None
            token = uuid.uuid4().hex
            conn.execute("""UPDATE jobs SET status='running',owner=?,attempt=?,lease_until=?,attempts=attempts+1,
                updated_at=?,error=NULL,error_code=NULL WHERE id=?""", (self.owner, token, now + self.lease_seconds, now, row["id"]))
            conn.commit()
        return self.get(row["id"])

    def _finish(self, row: dict, result: dict | None, error: str | None = None):
        with self.connection() as conn:
            now = time.time()
            conn.execute("""UPDATE jobs SET status=?,result=?,error=?,error_code=?,owner=NULL,lease_until=0,updated_at=?
                WHERE id=? AND owner=? AND attempt=? AND status='running' AND lease_until>?""",
                ("done" if result else "failed", json.dumps(result) if result else None, error,
                 None if result else "separation", now, row["id"], self.owner, row["attempt"], now))

    def tick(self):
        if self.active and self.process:
            row = self.get(self.active["id"])
            owns = row and row["status"] == "running" and row["owner"] == self.owner and row["attempt"] == self.active["attempt"] and row["lease_until"] > time.time()
            if not owns:
                self.process.terminate() if self.process.poll() is None else None
                self.process.wait(timeout=10)
                self.active = None
                self.process = None
                return
            if time.time() - self.active["updated_at"] > self.timeout_seconds:
                self.process.terminate() if self.process.poll() is None else None
                self.process.wait(timeout=10)
                self._finish(row, None, "Separation exceeded its time limit")
                self.active = None
                self.process = None
                return
            if self.process.poll() is not None:
                output = self.root / row["id"] / row["attempt"] / "result.json"
                try:
                    result = json.loads(output.read_text(encoding="utf-8"))
                    if "error" in result:
                        self._finish(row, None, result["error"])
                    elif not result.get("stems") or any(not (output.parent / stem["file"]).is_file() for stem in result["stems"]):
                        self._finish(row, None, "Separation returned incomplete output files")
                    else:
                        self._finish(row, result)
                except (OSError, ValueError, KeyError) as error:
                    self._finish(row, None, f"Separation worker stopped without a complete result: {error}")
                self.active = None
                self.process = None
            else:
                with self.connection() as conn:
                    conn.execute("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND owner=? AND attempt=? AND status='running' AND lease_until>?",
                                 (time.time() + self.lease_seconds, time.time(), row["id"], self.owner, row["attempt"], time.time()))
            return
        row = self.claim()
        if not row:
            return
        directory = self.root / row["id"] / row["attempt"]
        directory.mkdir(parents=True, exist_ok=True)
        try:
            with (directory / "worker.log").open("wb") as log:
                self.process = subprocess.Popen([sys.executable, str(self.worker), str(self.database), row["id"], row["attempt"]],
                    stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            self.active = row
        except OSError as error:
            self._finish(row, None, f"Could not start separation worker: {error}")

    def start(self):
        if self.thread:
            return
        def loop():
            while not self.stop_event.is_set():
                try:
                    self.tick()
                    if time.time() >= self.next_cleanup:
                        self.next_cleanup = time.time() + 60
                        self.purge_expired()
                except Exception as error:
                    print(f"Stem supervisor: {error}", flush=True)
                self.stop_event.wait(0.5)
        self.thread = threading.Thread(target=loop, name="stem-supervisor", daemon=True)
        self.thread.start()

    def purge_expired(self):
        with self.connection() as conn:
            rows = conn.execute("SELECT id,status FROM jobs WHERE status IN ('done','failed','cancelled') AND updated_at<?",
                                (time.time() - self.retention_seconds,)).fetchall()
            for row in rows:
                directory = (self.root / valid_id(row["id"])).resolve()
                if directory.parent != self.root:
                    raise ValueError("Refusing to remove stem data outside the job directory")
                if row["status"] == "done":
                    conn.execute("UPDATE jobs SET status='failed',result=NULL,error='Server results expired; cached app results remain available',error_code='expired' WHERE id=? AND status='done'", (row["id"],))
                if directory.is_dir():
                    shutil.rmtree(directory)
                # Keep IDs/cancellation tombstones so delayed uploads cannot restart work.

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=15)
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)
        with self.connection() as conn:
            conn.execute("UPDATE jobs SET lease_until=0 WHERE owner=? AND status='running'", (self.owner,))


def watch_lease(database: Path, job_id: str, attempt: str):
    """A child kills only itself if its durable ownership expires or is cancelled."""
    last_valid = time.monotonic()
    while True:
        time.sleep(0.5)
        try:
            with closing(sqlite3.connect(database, timeout=2)) as conn:
                row = conn.execute("SELECT status,attempt,lease_until FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row[0] != "running" or row[1] != attempt or row[2] <= time.time():
                os._exit(2)
            last_valid = time.monotonic()
        except sqlite3.Error:
            if time.monotonic() - last_valid > 20:
                os._exit(3)
