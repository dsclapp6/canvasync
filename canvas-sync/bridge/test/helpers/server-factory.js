// server-factory.js — starts the Express app in-process on an ephemeral port for tests.
// Caller must set CANVAS_SYNC_HOME and BRIDGE_PORT=0 before calling createServer().
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildApp } from '../../server.js';

export async function createServer() {
  const syncHome = process.env.CANVAS_SYNC_HOME
    ?? path.join(os.homedir(), 'Documents', 'CANVASync');
  const configPath = path.join(syncHome, 'config.json');
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);

  const app = buildApp(config);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}
