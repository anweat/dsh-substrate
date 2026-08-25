import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'cards.html'
  try {
    const body = readFileSync(join(here, 'out', name))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  } catch { res.writeHead(404); res.end('not found') }
}).listen(8792, '127.0.0.1', () => console.log('http://127.0.0.1:8792'))
