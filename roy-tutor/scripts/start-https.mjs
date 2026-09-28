// npm run start:https - the same tutor app and API as `npm start`, over HTTPS
// with a local development certificate, listening on every network adapter
// (0.0.0.0) so a phone on the same Wi-Fi or the laptop's hotspot can use the
// microphone. Development only.
//
//   https://<laptop-ip>:3443   the tutor (PORT, default 3443)
//   http://<laptop-ip>:3000    phone setup: download the certificate
//                               (TUTOR_SETUP_PORT, default 3000; "off" to disable)
//
// Certificates are created in roy-tutor/certs/ on first run (TUTOR_CERT_DIR to
// change). Your own certificate still works: set TUTOR_HTTPS_CERT and
// TUTOR_HTTPS_KEY and none is generated.
import { envFile } from '../src/env.js'; // loads .env first, so its settings apply
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevCerts, certHosts } from '../src/devcert.js';
import { lanAddresses } from '../src/network.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

env.PORT ||= '3443';
env.HOST ||= '0.0.0.0';

if (env.TUTOR_HTTPS_CERT && env.TUTOR_HTTPS_KEY) {
  console.log(`HTTPS: using your certificate from TUTOR_HTTPS_CERT${envFile ? ` (${path.basename(envFile)})` : ''}; no development certificate is generated.`);
} else {
  const dir = path.resolve(appDir, env.TUTOR_CERT_DIR || 'certs');
  const extra = (env.TUTOR_HTTPS_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  const hosts = certHosts({ lan: lanAddresses().map((a) => a.address), extra });
  const c = ensureDevCerts({ dir, hosts });
  if (c.made.ca) console.log(`HTTPS: created a new local development CA in ${c.dir} (install dev-ca.crt on the phone once).`);
  if (c.made.server) console.log(`HTTPS: issued a server certificate for ${hosts.join(', ')}`);
  else console.log(`HTTPS: server certificate covers ${hosts.join(', ')}`);
  env.TUTOR_HTTPS_CERT = c.cert;
  env.TUTOR_HTTPS_KEY = c.key;
  env.TUTOR_DEV_CA = c.caCert;
  env.TUTOR_DEV_CA_FINGERPRINT = c.caFingerprint;
}

await import('../server.js');
