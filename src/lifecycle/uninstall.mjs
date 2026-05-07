// if this is updated, update purl scripts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const cacheDir = path.resolve(os.homedir(), '.socket', 'vscode')
try {
  fs.rmSync(cacheDir, { recursive: true, force: true })
} catch {}
