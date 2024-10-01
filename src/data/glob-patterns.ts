import { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { once } from 'node:stream';
import { text } from 'stream/consumers';
import { flattenGlob } from '../util'

export type GlobPatterns = Record<string, Record<string, { pattern: string }>>

let globPatternsPromise: Promise<GlobPatterns> | undefined;

const replaceCasedChars = (chars: string) =>
    chars.replace(/[a-zA-Z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)

// TODO: can VSCode do case insensitive match without this?
function caseDesensitize(pattern: string) {
    let out = '';
    const charGroup = /\[[^\]]+?\]/g
    let lastIndex = 0;
    for (let match: RegExpExecArray | null = null; match = charGroup.exec(pattern);) {
        out += replaceCasedChars(pattern.slice(lastIndex, match.index)) + match[0];
        lastIndex = match.index + match[0].length;
    }
    out += replaceCasedChars(pattern.slice(lastIndex));
    return out;
}

export async function getGlobPatterns() {
    if (!globPatternsPromise) {
        const req = https.get('https://api.socket.dev/v0/report/supported')
        req.end()
        globPatternsPromise = (once(req, 'response') as Promise<[IncomingMessage]>)
            .then(async ([res]) => {
                const result = JSON.parse(await text(res))
                if (res.statusCode !== 200) {
                    throw new Error(result.error.message)
                }
                for (const eco in result) {
                    for (const name in result[eco]) {
                        const target = result[eco][name];
                        target.pattern = caseDesensitize(flattenGlob(target.pattern))
                    }
                }
                return result
            }).
            catch(err => {
                // allow retry
                globPatternsPromise = undefined
                throw err
            })
    }
    return globPatternsPromise
}
