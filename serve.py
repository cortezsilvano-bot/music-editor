"""Static server for the Music Editor build.

`python -m http.server` has two problems here. It serves .env, which holds an
API key. And it sends no cache headers, so a browser holds on to the unhashed
index.html and keeps requesting asset filenames from a previous build - which
shows up as a 404 for a hashed chunk that "should" exist.

This refuses dotfiles and tells the browser never to cache the entry point,
while letting it cache hashed assets forever.

    python serve.py                       # the app, on :8080
    python serve.py 8080 --dir legacy     # the original AI Studio build
"""

from __future__ import annotations

import http.server
import socketserver
import sys
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

# The built app, not this directory: serving the project root would expose .env
# and the source tree, and there is no page here to serve anyway.
ROOT = Path(__file__).resolve().parent / "app" / "dist"
DEFAULT_PORT = 8080

# Anything with a content hash in its name can be cached indefinitely; the entry
# point cannot, because its name never changes.
IMMUTABLE_SUFFIXES = (".js", ".css", ".woff2", ".wasm")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        # Decode first: %2Eenv is .env, and checking the raw path would miss it.
        path = unquote(self.path.split("?", 1)[0].split("#", 1)[0]).replace("\\", "/")
        # .env, .git, and anything else hidden stays unreachable.
        if any(part.startswith(".") and part not in (".", "..") for part in PurePosixPath(path).parts):
            self.send_error(404, "Not Found")
            return None
        # Belt and braces: never serve anything resolving outside the build dir.
        resolved = Path(self.translate_path(self.path)).resolve()
        if resolved != ROOT and ROOT not in resolved.parents:
            self.send_error(404, "Not Found")
            return None
        return super().send_head()

    def end_headers(self):
        name = PurePosixPath(unquote(self.path.split("?", 1)[0])).name
        # A hashed filename changes whenever its contents do, so it is safe to
        # cache forever. index.html must always be revalidated, or the browser
        # keeps requesting asset names from a build that no longer exists.
        if "-" in name and name.endswith(IMMUTABLE_SUFFIXES):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--dir" in sys.argv:
        ROOT = Path(sys.argv[sys.argv.index("--dir") + 1]).resolve()
        args = [a for a in args if a != str(ROOT) and Path(a) != ROOT]
    port = int(args[0]) if args and args[0].isdigit() else DEFAULT_PORT
    with Server(("127.0.0.1", port), Handler) as httpd:
        print(f"Music Editor  ->  http://localhost:{port}")
        print(f"Song Studio separation must also be running on :8787")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
