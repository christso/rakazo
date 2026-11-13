from http.server import BaseHTTPRequestHandler,HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers()
        self.wfile.write(b'<h1>Resource test fixture</h1><p>Local page is available. No external services or private data.</p>')
HTTPServer(('127.0.0.1',8765),H).serve_forever()
