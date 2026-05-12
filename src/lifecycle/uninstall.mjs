// if this is updated, update purl scripts
import os from 'node:os'
import path from 'node:path'
import { safeDeleteSync } from '@socketsecurity/lib/fs'
const cacheDir = path.resolve(os.homedir(), '.socket', 'vscode')
try {
  safeDeleteSync(cacheDir)
} catch {}
