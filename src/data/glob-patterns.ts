import { IncomingMessage } from 'node:http'
import * as https from 'node:https'
import { once } from 'node:stream'
import { text } from 'stream/consumers'
import { flattenGlob } from '../util'

export type GlobPatterns = Record<string, Record<string, { pattern: string }>>

let globPatternsPromise: Promise<GlobPatterns> | undefined

const replaceCasedChars = (chars: string) =>
    chars.replace(/[a-zA-Z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)

// TODO: can VSCode do case insensitive match without this?
function caseDesensitize(pattern: string) {
    let out = ''
    const charGroup = /\[[^\]]+?\]/g
    let lastIndex = 0
    for (let match: RegExpExecArray | null = null; match = charGroup.exec(pattern);) {
        out += replaceCasedChars(pattern.slice(lastIndex, match.index)) + match[0]
        lastIndex = match.index + match[0].length
    }
    out += replaceCasedChars(pattern.slice(lastIndex))
    return out
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
                        const target = result[eco][name]
                        target.pattern = caseDesensitize(flattenGlob(target.pattern))
                    }
                }
                return result
            }).
            catch(err => {
                // allow retry
                globPatternsPromise = undefined
                // snapshot of supported patterns
                return {
                    "cdx": { "json": { "pattern": "{bom,c{yclone,}dx[-.]*,*[-.]c{yclone,}dx}.json" }, "xml": { "pattern": "{bom,c{yclone,}dx[-.]*,*[-.]c{yclone,}dx}.xml" } },
                    "gem": { "gemfileLock": { "pattern": "Gemfile.lock" } },
                    "golang": { "gomod": { "pattern": "go.mod" }, "gosum": { "pattern": "go.sum" } },
                    "maven": { "buildr": { "pattern": "Buildfile" }, "gradle": { "pattern": "{*.,}gradle{.lockfile,}" }, "ivy": { "pattern": "ivy.xml" }, "kotlin": { "pattern": "*.gradle.kts" }, "leiningen": { "pattern": "project.clj" }, "pomxml": { "pattern": "{*-*.,}pom{.xml,}" }, "sbt": { "pattern": "build.sbt" } },
                    "npm": { "npmshrinkwrap": { "pattern": "npm-shrinkwrap.json" }, "packagejson": { "pattern": "package.json" }, "packagelockjson": { "pattern": "package-lock.json" }, "pnpmlock": { "pattern": "pnpm-lock.y{a,}ml" }, "pnpmworkspace": { "pattern": "pnpm-workspace.y{a,}ml" }, "yarnlock": { "pattern": "yarn.lock" } },
                    "pypi": { "cdx-json": { "pattern": "{bom,c{yclone,}dx[-.]*,*[-.]c{yclone,}dx}.json" }, "cdx-xml": { "pattern": "{bom,c{yclone,}dx[-.]*,*[-.]c{yclone,}dx}.xml" }, "pipfile": { "pattern": "pipfile" }, "piplock": { "pattern": "pipfile.lock" }, "pkginfo": { "pattern": "{PKG-INFO,METADATA}" }, "poetry": { "pattern": "poetry.lock" }, "pylock": { "pattern": "pylock{,.*}.toml" }, "pyproject": { "pattern": "pyproject.toml" }, "requirements": { "pattern": "{*requirements{.frozen,{[-_]*,}.txt},requirements/*.txt}" }, "setuppy": { "pattern": "setup.py" }, "spdx-json": { "pattern": "*[-.]spdx.json" }, "uvlock": { "pattern": "uv.lock" } }, "spdx": { "json": { "pattern": "*[-.]spdx.json" } },
                    "nuget": { "visualStudioSolution": { "pattern": "*.sln" }, "msbuildProject": { "pattern": "*.*proj" }, "targets": { "pattern": "*.targets" }, "props": { "pattern": "*.props" }, "msbuildProjectItems": { "pattern": "*.projitems" }, "nuspec": { "pattern": "*.nuspec" }, "packageConfig": { "pattern": "{packages.*.config,packages.config}" }, "packagesLock": { "pattern": "packages.lock.json" } },
                    "socket": { "facts": { "pattern": ".socket.facts.json" } },
                    "cargo": { "cargoToml": { "pattern": "Cargo.toml" }, "cargoLock": { "pattern": "Cargo.lock" } }
                }
            })
    }
    return globPatternsPromise
}
