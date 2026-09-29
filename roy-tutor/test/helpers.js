// Shared by the tests that start the real server.
import net from 'node:net';

// A port the OS says is free right now.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The environment for a test server, without the developer's own Qwen/tutor
// settings (spawned test servers also get TUTOR_ENV_FILE=none, so a real .env
// is never read).
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QWEN_|DASHSCOPE_|TUTOR_)/.test(k)));
}
