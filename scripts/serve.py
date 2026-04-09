#!/usr/bin/env python3
"""SPA dev server — serves index.html for /dig, /shuffle, and unknown paths."""
import http.server
import os

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Strip query string for path check
        path = self.path.split('?')[0].split('#')[0]
        # SPA routes → serve index.html
        if path in ('/dig', '/shuffle') or (path != '/' and not os.path.exists(path.lstrip('/'))):
            self.path = '/index.html'
        super().do_GET()

if __name__ == '__main__':
    s = http.server.HTTPServer(('', 8000), SPAHandler)
    print('SPA dev server on http://localhost:8000')
    s.serve_forever()
