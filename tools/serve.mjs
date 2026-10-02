// A small static server for trying the demo locally and for the end-to-end tests. No dependencies.
//   node tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * @param {number} port
 * @param {{ frameSrc?: string }} [options]  extra origins the clinic's page may frame (the API's origin, when it is running)
 */
export function startServer(port = 0, { frameSrc = null } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(ROOT, path));
    // Only the demo's own runtime files are served, never the repository's tests, tools or git data.
    const allowed = /^(index\.html|css\/|js\/|widget\/)/.test(file.slice(ROOT.length + 1).replace(/\\/g, '/') || 'index.html');
    try {
      if (!file.startsWith(ROOT) || !allowed) throw new Error('not served');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      let body = await readFile(file);
      // Only the clinic's page frames a widget, and only the one origin it is told about.
      if (frameSrc && file === join(ROOT, 'index.html')) body = Buffer.from(body.toString('utf8').replace("frame-src 'self'", `frame-src 'self' ${frameSrc}`));
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await startServer(Number(process.argv[2] ?? 8812));
  console.log(`Demo at http://127.0.0.1:${server.address().port}/`);
}
