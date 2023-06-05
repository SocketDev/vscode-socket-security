import { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { once } from 'node:stream';
import { text } from 'stream/consumers';

export type GlobPatterns = Record<string, Record<string, { pattern: string }>>

let globPatternsPromise: Promise<GlobPatterns> | undefined;

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