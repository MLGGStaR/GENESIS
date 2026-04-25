// Local dev static server only. Not used in production.
// On Netlify (or any static host), the files at the project root are served directly —
// this server.js is irrelevant for deployment.
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { networkInterfaces } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(__dirname, { extensions: ['html'] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const ifaces = networkInterfaces();
  let lan = 'localhost';
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) { lan = i.address; break; }
    }
  }
  console.log('');
  console.log('  GENESIS (dev)');
  console.log('  -------------');
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  LAN:    http://${lan}:${PORT}`);
  console.log('');
  console.log('  Multiplayer is fully P2P via PeerJS — no game-server needed.');
  console.log('');
});
