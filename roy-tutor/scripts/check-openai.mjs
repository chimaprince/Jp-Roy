// Connectivity check for the OpenAI API, from the same Node and .env the server uses.
//   npm run check-openai
// Tests each layer on its own (DNS, TCP, TLS, HTTPS, API key, model) and prints
// which problem it is. Never prints the API key.
import '../src/env.js';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const HOST = 'api.openai.com';
const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const TIMEOUT = 10000;

const redact = (s) => String(s ?? '').replace(/sk-[A-Za-z0-9_\-*.]{4,}/g, 'sk-[redacted]').slice(0, 600);
const line = (ok, label, detail = '') => console.log(`${ok === null ? '  ' : ok ? 'OK' : '!!'}  ${label}${detail ? ` - ${detail}` : ''}`);

// The real reason behind Node's generic "fetch failed".
function cause(err) {
  let e = err;
  const parts = [];
  while (e) {
    parts.push([e.code, e.message].filter(Boolean).join(' '));
    e = e.cause;
  }
  return parts.join(' <- ');
}
function causeCode(err) {
  let e = err;
  let code = null;
  while (e) { code = e.code ?? code; e = e.cause; }
  return code;
}

function proxyHost(v) {
  try { const u = new URL(v); return `${u.protocol}//${u.hostname}:${u.port || '(default)'}`; } catch { return '(unparseable)'; }
}

async function main() {
  const verdicts = [];
  console.log('Environment');
  line(null, `Node ${process.version} on ${process.platform}`);
  line(Boolean(KEY), 'OPENAI_API_KEY', KEY ? `set, ${KEY.length} characters, ${KEY.startsWith('sk-') ? 'starts with sk-' : 'does NOT start with sk-'}${/\s/.test(KEY) ? ', CONTAINS WHITESPACE' : ''}${/^["']|["']$/.test(KEY) ? ', HAS QUOTES AROUND IT' : ''}` : 'not set');
  line(null, 'OPENAI_MODEL', MODEL);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  line(null, 'Proxy variable', proxy ? proxyHost(proxy) : 'none set');
  line(null, 'NODE_USE_ENV_PROXY', process.env.NODE_USE_ENV_PROXY ?? 'not set (Node fetch ignores HTTPS_PROXY unless this is 1)');
  line(null, 'NODE_EXTRA_CA_CERTS', process.env.NODE_EXTRA_CA_CERTS ? 'set' : 'not set');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') line(false, 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set (unsafe; remove it)');

  console.log('\n1. DNS');
  let address = null;
  try {
    const r = await dns.lookup(HOST);
    address = r.address;
    line(true, `${HOST} resolves`, r.address);
  } catch (err) {
    line(false, `${HOST} does not resolve`, cause(err));
    verdicts.push(proxy ? 'E' : 'C');
  }

  console.log('\n2. Direct TCP connection to port 443');
  let tcpOk = false;
  if (address) {
    tcpOk = await new Promise((resolve) => {
      const s = net.connect({ host: HOST, port: 443, timeout: TIMEOUT });
      s.on('connect', () => { line(true, 'connected'); s.destroy(); resolve(true); });
      s.on('timeout', () => { line(false, 'timed out', 'nothing answered; a firewall is probably dropping traffic'); s.destroy(); resolve(false); });
      s.on('error', (err) => { line(false, 'failed', cause(err)); resolve(false); });
    });
  } else line(null, 'skipped (no DNS)');

  console.log('\n3. Direct TLS handshake');
  let tlsOk = false;
  if (tcpOk) {
    tlsOk = await new Promise((resolve) => {
      const s = tls.connect({ host: HOST, port: 443, servername: HOST, timeout: TIMEOUT });
      s.on('secureConnect', () => {
        const cert = s.getPeerCertificate();
        line(s.authorized, `TLS ${s.getProtocol()}`, `certificate issued to ${cert.subject?.CN ?? '?'} by ${cert.issuer?.O ?? cert.issuer?.CN ?? '?'}${s.authorized ? '' : `; NOT TRUSTED: ${s.authorizationError}`}`);
        s.destroy();
        resolve(s.authorized);
      });
      s.on('timeout', () => { line(false, 'TLS timed out'); s.destroy(); resolve(false); });
      s.on('error', (err) => { line(false, 'TLS failed', cause(err)); resolve(false); });
    });
    if (!tlsOk) verdicts.push('D');
  } else line(null, 'skipped (no direct TCP connection)');

  console.log('\n4. HTTPS request with Node fetch, no API key (expect HTTP 401)');
  let reachable = false;
  try {
    const res = await fetch(`https://${HOST}/v1/models`, { signal: AbortSignal.timeout(TIMEOUT) });
    const body = await res.text();
    const fromOpenAI = Boolean(res.headers.get('openai-version') || res.headers.get('x-request-id') || /invalid_request_error|api key/i.test(body));
    if (fromOpenAI) {
      reachable = true;
      line(true, `OpenAI answered HTTP ${res.status}`, 'the network path works');
    } else {
      line(false, `HTTP ${res.status} from something other than OpenAI`, redact(body));
      verdicts.push('E');
    }
  } catch (err) {
    line(false, 'fetch failed', cause(err));
    const code = causeCode(err);
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/i.test(code ?? '')) verdicts.push('D');
    else if (proxy && !process.env.NODE_USE_ENV_PROXY) verdicts.push('E');
    else if (tcpOk) verdicts.push('F');
    else verdicts.push(proxy ? 'E' : 'C');
  }

  console.log('\n5. Same request with your API key');
  let keyOk = false;
  if (!KEY) {
    line(false, 'skipped', 'OPENAI_API_KEY is not set');
    verdicts.push('F');
  } else if (reachable) {
    const res = await fetch(`https://${HOST}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(TIMEOUT) });
    const body = await res.text();
    if (res.ok) {
      keyOk = true;
      const ids = (JSON.parse(body).data ?? []).map((m) => m.id);
      line(true, `HTTP ${res.status}: key accepted`, `${ids.length} models available; ${MODEL} ${ids.includes(MODEL) ? 'is' : 'is NOT'} among them`);
      if (!ids.includes(MODEL)) {
        line(false, `set OPENAI_MODEL in .env to one of your models`, ids.filter((id) => /^(gpt|o\d)/.test(id)).slice(0, 12).join(', '));
        verdicts.push('F');
      }
    } else {
      line(false, `HTTP ${res.status}`, redact(body));
      verdicts.push(res.status === 401 ? 'A' : 'B');
    }
  } else line(null, 'skipped (OpenAI not reachable)');

  console.log('\n6. Smallest chat completion with OPENAI_MODEL');
  if (keyOk) {
    const res = await fetch(`https://${HOST}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_completion_tokens: 200 }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      line(true, `HTTP ${res.status}`, `model ${j.model} replied "${redact(j.choices?.[0]?.message?.content ?? '').trim()}"`);
    } else {
      line(false, `HTTP ${res.status}`, redact(body));
      verdicts.push(res.status === 401 ? 'A' : res.status === 404 || /model/i.test(body) ? 'F' : 'B');
    }
  } else line(null, 'skipped');

  const MEANING = {
    A: 'API key is invalid',
    B: 'OpenAI API is reachable but returning an HTTP error',
    C: 'DNS/network connection is failing',
    D: 'TLS/SSL connection is failing',
    E: 'Proxy/firewall is blocking the request',
    F: 'Code/configuration error',
  };
  console.log('\nResult');
  const found = [...new Set(verdicts)];
  if (!found.length) console.log('  All checks passed. The tutor can reach OpenAI.');
  for (const v of found) console.log(`  ${v}. ${MEANING[v]}`);
  process.exit(found.length ? 1 : 0);
}

main().catch((err) => { console.error('check failed unexpectedly:', cause(err)); process.exit(2); });
