// if this is updated, update purl scripts
import fs from 'fs'
import os from 'os'
import path from 'path'
const cacheDir = path.resolve(os.homedir(), '.socket', 'vscode')
try {
    fs.rmSync(cacheDir, { recursive: true, force: true })
} catch {}
