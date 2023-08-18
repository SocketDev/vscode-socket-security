import wasmBinary from './mod-parser.wasm'
import GoExecutor from './wasm-executor'

const executor = new GoExecutor<{
    parseGoMod (src: string): string
}>()
let goWASM: Promise<typeof executor['exports']> | undefined

export interface GoPosition {
    Line: number
    LineRune: number
    Byte: number
}

export interface GoComment {
    Start: GoPosition
    Token: string
    Suffix: boolean
}

export interface GoComments {
    Before: Comment[] | null
    Suffix: Comment[] | null
    After: Comment[] | null
}

export interface GoLine extends GoComments {
    Start: GoPosition
    Token: string[]
    InBlock: boolean
    End: GoPosition
}

export interface GoModuleVersion {
    Path: string
    Version?: string
}

export interface GoModule {
    Mod: GoModuleVersion
    Deprecated: string
    Syntax: GoLine
}

export interface GoModInfo {
    Version: string
    Syntax: GoLine
}

export interface GoToolchain {
    Name: string
    Syntax: GoLine
}

export interface GoRequire {
    Mod: GoModuleVersion
    Indirect: boolean
    Syntax: GoLine
}

export interface GoExclude {
    Mod: GoModuleVersion
    Syntax: GoLine
}

export interface GoReplace {
    Old: GoModuleVersion
    New: GoModuleVersion
    Syntax: GoLine
}

export interface GoVersionInterval {
    Low: string
    High: string
}

export interface GoRetract extends GoVersionInterval {
    Rationale: string
    Syntax: GoLine
}

export interface GoCommentBlock extends GoComments {
    Start: GoPosition
}

export interface GoLParen extends GoComments {
    Pos: GoPosition
}

export interface GoRParen extends GoComments {
    Pos: GoPosition
}

export interface GoLineBlock extends GoComments {
	Start: GoPosition
	LParen: GoLParen
	Token: string[]
	Line: GoLine[]
	RParen: GoRParen
}

export interface GoFileSyntax extends GoComments {
    Name: string
    Stmt: (GoCommentBlock | GoLineBlock | GoLine)[]
}

export interface GoModFile {
    Module: GoModule | null
    Go: GoModInfo | null
    Toolchain: GoToolchain | null
    Require: GoRequire[] | null
    Exclude: GoExclude[] | null
    Replace: GoReplace[] | null
    Retract: GoRetract[] | null
    Syntax: GoFileSyntax
}

interface GoParseError {
    Error: string
}

const isParseError = (data: unknown): data is GoParseError =>
    typeof (data as GoParseError).Error === 'string'

export async function parseGoMod (src: string): Promise<GoModFile | null> {
    if (!goWASM) {
        goWASM = WebAssembly.instantiate(wasmBinary, {
            go: executor.goImportObject
        }).then(result => {
            void executor.run(result.instance)
            return executor.exports
        })
    }
    const wasmExports = await goWASM
    const result: GoModFile | GoParseError = JSON.parse(wasmExports.parseGoMod(src))
    if (isParseError(result)) return null
    return result
}