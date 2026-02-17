#!/usr/bin/env python3
"""
Minimal CORS-enabled HTTP file server for local testing with Listen Here!

Usage:
    python3 serve_local.py <directory> [port] [--auth user:pass]

Examples:
    python3 serve_local.py app/static/wav/Kaiserwalzer 8080
    python3 serve_local.py app/static/wav/Kaiserwalzer 8080 --auth test:test

Then use the Listen Here! tool with ?useLocal:
    http://localhost:5000/?align=<alignment_url>&useLocal=http://localhost:8080

When --auth is specified, the server requires HTTP Basic Authentication.
Listen Here! will automatically detect the 401 response and prompt for credentials.
"""

import base64
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Will be set from CLI args if --auth is used
AUTH_TOKEN = None


class CORSHandler(SimpleHTTPRequestHandler):
    def _cors_origin(self):
        # Echo the requesting origin (required when credentials are used);
        # fall back to * for simple requests without an Origin header.
        return self.headers.get("Origin", "*")

    def check_auth(self):
        if AUTH_TOKEN is None:
            return True
        auth = self.headers.get("Authorization")
        if auth == f"Basic {AUTH_TOKEN}":
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Listen Here! audio"')
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Headers", "Range, Authorization")
        self.end_headers()
        return False

    def do_GET(self):
        if not self.check_auth():
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Authorization")
        self.end_headers()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)

    directory = sys.argv[1]
    port = 8080
    args = sys.argv[2:]

    # Parse optional arguments
    i = 0
    while i < len(args):
        if args[i] == "--auth" and i + 1 < len(args):
            creds = args[i + 1]
            if ":" not in creds:
                print("Error: --auth value must be in user:pass format")
                sys.exit(1)
            AUTH_TOKEN = base64.b64encode(creds.encode()).decode()
            i += 2
        else:
            port = int(args[i])
            i += 1

    os.chdir(directory)
    server = HTTPServer(("", port), CORSHandler)
    print(f"Serving {os.path.abspath('.')} on http://127.0.0.1:{port}")
    if AUTH_TOKEN:
        print("Basic authentication enabled.")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
