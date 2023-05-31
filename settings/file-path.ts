import { homedir } from 'os'
import path from 'path'
export const filepath = path.join(homedir(), '.config', 'socket', 'settings.json')
