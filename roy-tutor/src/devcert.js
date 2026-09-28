// Local HTTPS for development: a private certificate authority (CA) that lives
// only on this laptop, and a server certificate signed by it for localhost and
// the laptop's network addresses. The phone trusts the CA once (installed as a
// profile on iPhone); after that https://<laptop-ip>:3443 is a secure context,
// so the microphone works.
//
// Files (in roy-tutor/certs/, ignored by Git):
//   dev-ca.crt      the CA certificate - public, this is what the phone installs
//   dev-ca-key.pem  the CA private key - never served, never leaves the laptop
//   dev-server.crt / dev-server-key.pem  the HTTPS server's certificate and key
//
// The CA is kept across runs so the phone only has to trust it once. The
// server certificate is re-issued when the laptop's addresses change or it is
// close to expiry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';

const DAY = 24 * 60 * 60 * 1000;
// iPhone rejects server certificates valid for more than 825 days; stay well under.
export const SERVER_CERT_DAYS = 397;
export const CA_YEARS = 10;
// Windows Mobile Hotspot gives the laptop this address on the hotspot network.
export const WINDOWS_HOTSPOT_IP = '192.168.137.1';

export function certPaths(dir) {
  return {
    dir,
    caCert: path.join(dir, 'dev-ca.crt'),
    caKey: path.join(dir, 'dev-ca-key.pem'),
    cert: path.join(dir, 'dev-server.crt'),
    key: path.join(dir, 'dev-server-key.pem'),
  };
}

function newKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const priv = forge.pki.privateKeyFromPem(pem);
  return { pem, priv, pub: forge.pki.setRsaPublicKey(priv.n, priv.e) };
}

function serial() {
  // Positive, random, 16 bytes.
  return `01${crypto.randomBytes(15).toString('hex')}`;
}

function makeCa(now) {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(now - DAY);
  cert.validity.notAfter = new Date(now + CA_YEARS * 365 * DAY);
  const name = [
    { name: 'commonName', value: `Roy Tutor Local Dev CA (${os.hostname()})` },
    { name: 'organizationName', value: 'Roy Tutor development only' },
  ];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.priv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.pem };
}

function makeServerCert({ caCertPem, caKeyPem, hosts, now }) {
  const ca = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(now - DAY);
  cert.validity.notAfter = new Date(now + SERVER_CERT_DAYS * DAY);
  cert.setSubject([{ name: 'commonName', value: 'Roy Tutor (local development)' }]);
  cert.setIssuer(ca.subject.attributes);
  const altNames = hosts.map((h) => (net4(h) ? { type: 7, ip: h } : { type: 2, value: h }));
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.pem };
}

const net4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

// Does this server certificate still fit: signed by this CA, covers every
// host, and not about to expire?
function serverCertOk(certPem, caCertPem, hosts, now) {
  try {
    const cert = new crypto.X509Certificate(certPem);
    const ca = new crypto.X509Certificate(caCertPem);
    if (!cert.verify(ca.publicKey)) return false;
    if (Date.parse(cert.validTo) - now < 30 * DAY) return false;
    return hosts.every((h) => (net4(h) ? cert.checkIP(h) : cert.checkHost(h)) !== undefined);
  } catch {
    return false;
  }
}

// Hosts the server certificate must cover.
export function certHosts({ lan = [], extra = [] } = {}) {
  return [...new Set(['localhost', '127.0.0.1', WINDOWS_HOTSPOT_IP, ...lan, ...extra].filter(Boolean))];
}

// Creates what is missing; returns the file paths and what was (re)made.
export function ensureDevCerts({ dir, hosts, now = Date.now() }) {
  const p = certPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  const made = { ca: false, server: false };
  if (!fs.existsSync(p.caCert) || !fs.existsSync(p.caKey)) {
    const ca = makeCa(now);
    fs.writeFileSync(p.caCert, ca.certPem);
    fs.writeFileSync(p.caKey, ca.keyPem, { mode: 0o600 });
    made.ca = true;
  }
  const caCertPem = fs.readFileSync(p.caCert, 'utf8');
  const current = fs.existsSync(p.cert) && fs.existsSync(p.key) ? fs.readFileSync(p.cert, 'utf8') : null;
  if (made.ca || !current || !serverCertOk(current, caCertPem, hosts, now)) {
    const server = makeServerCert({ caCertPem, caKeyPem: fs.readFileSync(p.caKey, 'utf8'), hosts, now });
    fs.writeFileSync(p.cert, server.certPem);
    fs.writeFileSync(p.key, server.keyPem, { mode: 0o600 });
    made.server = true;
  }
  const ca = new crypto.X509Certificate(caCertPem);
  return { ...p, made, hosts, caFingerprint: ca.fingerprint256 };
}
