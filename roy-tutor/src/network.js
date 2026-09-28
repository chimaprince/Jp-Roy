// Local-network helpers for development: which addresses other devices on the
// same Wi-Fi can use to reach this server.
import os from 'node:os';

// IPv4 addresses of this machine's network adapters, excluding loopback and
// link-local (169.254.x.x) addresses.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

export function serverUrls({ host, port, secure, interfaces } = {}) {
  const scheme = secure ? 'https' : 'http';
  const local = `${scheme}://localhost:${port}`;
  const everywhere = host === '0.0.0.0' || host === '::';
  const lan = everywhere ? lanAddresses(interfaces).map((a) => ({ ...a, url: `${scheme}://${a.address}:${port}` })) : [];
  return { local, lan };
}
