#!/usr/bin/env python3
"""
Minimal CORS-enabled HTTP file server for local testing with Listen Here!

Usage:
    python3 serve_local.py <directory> [port]

Example:
    python3 serve_local.py app/static/wav/Kaiserwalzer 8080

Then use the Listen Here! tool with ?useLocal:
    http://localhost:5000/?align=<alignment_url>&useLocal=http://localhost:8080
"""

import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CORSHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.end_headers()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)

    directory = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080

    os.chdir(directory)
    server = HTTPServer(("", port), CORSHandler)
    print(f"Serving {os.path.abspath('.')} on http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
