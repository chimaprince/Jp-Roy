// HTTPS development mode helper: a small plain-HTTP server (default port 3000)
// that exists only so a phone can download the local CA certificate before it
// trusts HTTPS. It serves:
//   /            a page with the steps and the links
//   /dev-ca.crt  the CA certificate (public; the private key is never served)
// Everything else redirects to the HTTPS tutor. The tutor API is not served
// over plain HTTP in this mode.
import fs from 'node:fs';
import http from 'node:http';

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function setupPage({ httpsUrl, fingerprint }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roy tutor: trust the development certificate</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:36rem;margin:1.5rem auto;padding:0 1rem;line-height:1.5}
a.btn{display:block;text-align:center;padding:.9rem;margin:.8rem 0;border-radius:.6rem;background:#0a66c2;color:#fff;text-decoration:none;font-weight:600}
code{word-break:break-all;font-size:.8rem}</style></head><body>
<h1>Roy Medical Chinese: phone setup</h1>
<p>The microphone needs <b>https</b>. Do this once on the iPhone:</p>
<ol>
<li>Tap <b>Download certificate</b> below (in Safari), then <b>Allow</b>.</li>
<li>Settings › General › VPN &amp; Device Management › <b>Roy Tutor Local Dev CA</b> › Install.</li>
<li>Settings › General › About › Certificate Trust Settings › turn <b>on</b> full trust for <b>Roy Tutor Local Dev CA</b>.</li>
<li>Open the tutor over https.</li>
</ol>
<a class="btn" href="/dev-ca.crt">Download certificate</a>
<a class="btn" href="${escapeHtml(httpsUrl)}">Open the tutor (https)</a>
<p>Certificate fingerprint (SHA-256), to compare with the laptop's terminal:<br><code>${escapeHtml(fingerprint)}</code></p>
<p>Development only. The certificate works only for this laptop's own addresses.</p>
</body></html>`;
}

// httpsPort: where the tutor runs; caFile: the public CA certificate.
export function createSetupServer({ caFile, httpsPort, fingerprint }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
    const httpsUrl = `https://${host}:${httpsPort}/`;
    if (req.method === 'GET' && url.pathname === '/dev-ca.crt') {
      // This MIME type makes iPhone Safari offer to install the profile.
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="roy-tutor-dev-ca.crt"' });
      return res.end(fs.readFileSync(caFile));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup')) {
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(setupPage({ httpsUrl, fingerprint }));
    }
    res.writeHead(302, { ...HEADERS, Location: `https://${host}:${httpsPort}${url.pathname}${url.search}` });
    res.end();
  });
}
