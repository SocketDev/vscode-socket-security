import * as toml from 'toml-eslint-parser'
import * as vscode from 'vscode'

export const DIAGNOSTIC_SOURCE_STR = 'SocketSecurity'
export const EXTENSION_PREFIX = 'socket-security'

export function addDisposablesTo(all?: Array<vscode.Disposable>, ...disposables: Array<vscode.Disposable>): void {
    if (all) {
        all.push(...disposables)
    }
}

export function getWorkspaceFolderURI(from: vscode.Uri) {
    return vscode.workspace.getWorkspaceFolder(from)?.uri
}

export function traverseTOMLKeys(src: toml.AST.TOMLProgram, cb: (key: toml.AST.TOMLKey, path: (string | number)[]) => unknown) {
    const curPath: (string | number)[] = []

    toml.traverseNodes(src, {
        enterNode(node) {
            if (node.type === 'TOMLKeyValue') {
                curPath.push(...node.key.keys.map(k => k.type == 'TOMLBare' ? k.name : k.value))
            } else if (node.type === 'TOMLTable') {
                curPath.push(...node.resolvedKey)
            } else if (node.type === 'TOMLKey') {
                cb(node, curPath)
            }
        },
        leaveNode(node) {
            if (node.type === 'TOMLKeyValue') {
                curPath.length -= node.key.keys.length
            } else if (node.type === 'TOMLTable') {
                curPath.length -= node.resolvedKey.length
            }
        }
    })
}

export function flattenGlob(glob: string) {
    type Item = Alternation | Concatenation | string
    class Alternation {
        alternates: Item[]
        constructor(items: Alternation['alternates'] = []) {
            this.alternates = items
        }
        push(item: Item) {
            this.alternates.push(item)
        }
        explode(): string[] {
            let options: string[] = []
            for (const alternate of this.alternates) {
                if (typeof alternate === 'string') {
                    options.push(alternate)
                } else if (alternate instanceof Concatenation) {
                    options.push(...alternate.explode())
                } else if (alternate instanceof Alternation) {
                    options.push(...alternate.explode())
                }
            }
            return options
        }
    }

    class Concatenation {
        segments: Item[]
        constructor(items: Concatenation['segments'] = []) {
            this.segments = items
        }
        push(item: Item) {
            this.segments.push(item)
        }
        explode(): string[] {
            let prefixed = ['']
            for (const segment of this.segments) {
                let suffixes: string[]
                if (typeof segment === 'string') {
                    suffixes = [segment]
                } else if (segment instanceof Concatenation) {
                    suffixes = segment.explode()
                } else if (segment instanceof Alternation) {
                    suffixes = segment.explode()
                } else {
                    throw new Error('unreachable')
                }
                if (suffixes.length > 0) {
                    prefixed = prefixed.flatMap(prefix => {
                        return suffixes.map(suffix => `${prefix}${suffix}`)
                    })
                }
            }
            return prefixed
        }
    }

    function explode(str: string) {
        let finder = /\\[\s\S]|[{},]/g
        let root = new Concatenation()
        let stack: Array<Alternation | Concatenation> = [root]
        let right = 0
        let match = finder.exec(str)
        while (match) {
            try {
                let c = match[0]
                if (c[0] === '\\') {
                    let prefix = str.slice(right, match.index) + c
                    let current = stack.at(-1)!
                    current.push(prefix)
                    continue
                } else if (c === '{') {
                    let prefix = str.slice(right, match.index)
                    let a = new Alternation()
                    let c = new Concatenation()
                    let current = stack.at(-1)!
                    current.push(prefix)
                    current.push(a)
                    a.push(c)
                    stack.push(a)
                    stack.push(c)
                } else if (c === '}') {
                    let current = stack.at(-1)!
                    if (stack.length <= 1) {
                        current.push(c)
                        continue
                    }
                    let tail = str.slice(right, match.index)
                    let concat = stack.pop()!
                    let alternate = stack.pop()!
                    concat.push(tail)
                } else if (c === ',') {
                    let current = stack.at(-1)!
                    if (stack.length <= 1) {
                        current.push(c)
                        continue
                    }
                    let tail = str.slice(right, match.index)
                    let concat = stack.pop()!
                    concat.push(tail)
                    let next = new Concatenation()
                    stack.at(-1)!.push(next)
                    stack.push(next)
                }
            }
            finally {
                right = finder.lastIndex
                match = finder.exec(str)
            }
        }
        let tail = str.slice(right)
        stack.at(-1)!.push(tail)
        return root.explode()
    }

    const parts = explode(glob)
    return parts.length > 1 ? `{${parts.join(',')}}` : parts[0]
}
