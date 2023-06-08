import * as vscode from 'vscode';
import * as parser from '@babel/parser'
import * as astTypes from 'ast-types';
import micromatch from 'micromatch';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import jsonToAST from 'json-to-ast';
import * as toml from 'toml-eslint-parser';
import { getPythonInterpreter } from '../data/python-interpreter';
import { getGlobPatterns } from '../data/glob-patterns';
import { traverseTOMLKeys } from '../util';

type ExternalRef = {
    name: string,
    range: vscode.Range,
    prioritize?: boolean
}

export const SUPPORTED_LANGUAGES: Record<string, string> = {
    javascript: 'npm',
    javascriptreact: 'npm',
    typescript: 'npm',
    typescriptreact: 'npm',
    python: 'pypi'
}

function getJSPackageNameFromSpecifier(name: string): string {
    return (
        name.startsWith('@') ?
        name.split('/', 2) :
        name.split('/', 1)
    ).join('/');
}
function getJSPackageNameFromVersionRange(name: string): string {
    return (
        name.startsWith('@') ?
        name.split('@', 3) :
        name.split('@', 2)
    ).join('@');
}
export async function parseExternals(doc: Pick<vscode.TextDocument, 'getText' | 'languageId' | 'fileName'>): Promise<Iterable<ExternalRef> | null> {
    const src = doc.getText();
    const results: Array<ExternalRef> = []
    if (SUPPORTED_LANGUAGES[doc.languageId] === 'npm') {
        let ast
        try {
            ast = parser.parse(
                src,
                {
                    allowAwaitOutsideFunction: true,
                    allowImportExportEverywhere: true,
                    allowReturnOutsideFunction: true,
                    errorRecovery: true,
                    plugins: [
                        'jsx',
                        'typescript',
                        'decorators'
                    ],
                }
            )
        } catch {
            return null
        }
        function addResult(node: astTypes.namedTypes.Node, specifier: string) {
            if (/^[\.\/]/u.test(specifier)) {
                return
            }
            const pkgName = getJSPackageNameFromSpecifier(specifier)
            const loc = node.loc
            if (!loc) return
            const startPos: vscode.Position = new vscode.Position(loc.start.line - 1, loc.start.column)
            const endPos: vscode.Position = new vscode.Position(loc.end.line - 1, loc.end.column)
            const range = new vscode.Range(startPos, endPos)
            results.push({
                range,
                name: pkgName
            })
        }
        const kDYNAMIC_VALUE: unique symbol = Symbol('dynamic_value')
        type DYNAMIC_VALUE = typeof kDYNAMIC_VALUE
        type PRIMITIVE = bigint | boolean | null | number | string | undefined
        /**
         * Lazy evaluator for finding out if something is constant at compile time
         * 
         * Used to deal w/ some things like require('@babel/${'traverse'}') generated code
         * 
         * Does not support compile time symbols (well known ones)
         * Does not support regexp symbols
         * Does not support array literals
         * Does not support object literals
         *
         * @returns a function to compute the value (may be non-trivial cost)
         */
        function constFor(node: astTypes.ASTNode): DYNAMIC_VALUE | (() => PRIMITIVE) {
            if (astTypes.namedTypes.TemplateLiteral.check(node)) {
                if (node.quasis.length === 1) {
                    return () => node.quasis[0].value.cooked
                } else {
                    let constExps: Array<Exclude<ReturnType<typeof constFor>, DYNAMIC_VALUE>> = []
                    for (const exp of node.expressions) {
                        let constExp = constFor(exp)
                        if (constExp === kDYNAMIC_VALUE) {
                            return kDYNAMIC_VALUE
                        }
                        constExps.push(constExp)
                    }
                    return () => {
                        let result = ''
                        let i
                        for (i = 0; i < node.quasis.length - 1; i++) {
                            result += `${node.quasis[i].value.cooked}${constExps[i]()}`
                        }
                        return `${result}${node.quasis[i].value.cooked}`
                    }
                }
            } else if (astTypes.namedTypes.BigIntLiteral.check(node)) {
                return () => BigInt(node.value)
            } else if (astTypes.namedTypes.Literal.check(node)) {
                const { value } = node
                if (value && typeof value === 'object') {
                    // regexp literal
                    return kDYNAMIC_VALUE
                }
                return () => value
            } else if (astTypes.namedTypes.BinaryExpression.check(node)) {
                const left = constFor(node.left)
                if (left === kDYNAMIC_VALUE) {
                    return kDYNAMIC_VALUE
                }
                const right = constFor(node.right)
                if (right === kDYNAMIC_VALUE) {
                    return kDYNAMIC_VALUE
                }
                let { operator } = node
                if (operator === 'in' || operator === 'instanceof') {
                    return kDYNAMIC_VALUE
                }
                // lots of TS unhappy with odd but valid coercions
                return {
                    '==': () => left() == right(),
                    '!=': () => left() != right(),
                    '===': () => left() === right(),
                    '!==': () => left() !== right(),
                    // @ts-expect-error
                    '<': () => left() < right(),
                    // @ts-expect-error
                    '<=': () => left() <= right(),
                    // @ts-expect-error
                    '>': () => left() > right(),
                    // @ts-expect-error
                    '>=': () => left() >= right(),
                    // @ts-expect-error
                    '<<': () => left() << right(),
                    // @ts-expect-error
                    '>>': () => left() >> right(),
                    // @ts-expect-error
                    '>>>': () => left() >>> right(),
                    // @ts-expect-error
                    '+': () => left() + right(),
                    // @ts-expect-error
                    '-': () => left() - right(),
                    // @ts-expect-error
                    '*': () => left() * right(),
                    // @ts-expect-error
                    '/': () => left() / right(),
                    // @ts-expect-error
                    '%': () => left() % right(),
                    // @ts-expect-error
                    '&': () => left() & right(),
                    // @ts-expect-error
                    '|': () => left() | right(),
                    // @ts-expect-error
                    '^': () => left() ^ right(),
                    // @ts-expect-error
                    '**': () => left() ** right()
                }[operator]
            } else if (astTypes.namedTypes.UnaryExpression.check(node)) {
                const arg = constFor(node.argument)
                if (arg === kDYNAMIC_VALUE) {
                    return kDYNAMIC_VALUE
                }
                const { operator } = node
                if (operator === 'delete') {
                    return kDYNAMIC_VALUE
                }
                if (operator === 'void') {
                    return () => undefined
                }
                return {
                    // @ts-expect-error
                    '-': () => -arg(),
                    // @ts-expect-error
                    '+': () => +arg(),
                    '!': () => !arg(),
                    // @ts-expect-error
                    '~': () => ~arg(),
                    'typeof': () => typeof arg(),
                }[operator]
            } else if (astTypes.namedTypes.ParenthesizedExpression.check(node)) {
                return constFor(node.expression)
            } else if (astTypes.namedTypes.AwaitExpression.check(node)) {
                if (!node.argument) {
                    // WTF
                    return kDYNAMIC_VALUE
                }
                const arg = constFor(node.argument)
                if (arg === kDYNAMIC_VALUE) {
                    return kDYNAMIC_VALUE
                }
                return arg
            }
            return kDYNAMIC_VALUE
        }
        astTypes.visit(ast, {
            visitImportDeclaration(path) {
                addResult(path.node.source, `${path.node.source.value}`)
                return false
            },
            visitImportExpression(path) {
                const { node } = path
                let constantArg = constFor(node.source)
                if (constantArg !== kDYNAMIC_VALUE) {
                    addResult(node, `${constantArg()}`)
                }
                this.traverse(path)
            },
            visitCallExpression(path) {
                const { node } = path
                const { callee } = node
                if (node.arguments.length > 0) {
                    if (astTypes.namedTypes.Identifier.check(callee) && callee.name === 'require') {
                        const { arguments: [firstArg] } = node
                        let constantArg = constFor(firstArg)
                        if (constantArg !== kDYNAMIC_VALUE) {
                            addResult(node, `${constantArg()}`)
                        }
                    } else if (astTypes.namedTypes.Import.check(callee)) {
                        const { arguments: [firstArg] } = node
                        let constantArg = constFor(firstArg)
                        if (constantArg !== kDYNAMIC_VALUE) {
                            addResult(node, `${constantArg()}`)
                        }
                    }
                }
                this.traverse(path)
            }
        })
    } else if (SUPPORTED_LANGUAGES[doc.languageId] === 'pypi') {
        const pythonInterpreter = await getPythonInterpreter()
        if (pythonInterpreter) {
            const childProcess = await import('node:child_process');
            // Python dependency extractor
            // handles basic constant folding + dynamic import extraction
            // some limited error correction functionality
            
            // possible future TODO: use python tokenizer with error-correcting
            // indents and manually parse - better perf + accuracy
            const proc = childProcess.spawn(pythonInterpreter, ['-c', `
import ast, tokenize, token, json, sys, io

src = u${JSON.stringify(src)}
src_lines = src.split(u'\\n')

xrefs = []
pending_xref = None

def make_range(sl, sc, el, ec):
    return {
        "start": {
            "line": sl,
            "character": sc
        },
        "end":  {
            "line": el,
            "character": ec
        }
    }

def set_loc(node):
    save_pending_xref(node.lineno - 1, node.col_offset - 1)

def save_pending_xref(end_line, end_col):
    global pending_xref, xrefs
    if pending_xref is not None:
        names, start_node = pending_xref
        while True:
            while end_col < 0 or end_col >= len(src_lines[end_line]):
                end_line -= 1
                end_col = len(src_lines[end_line]) - 1
            if not src_lines[end_line][end_col].isspace():
                break
            end_col -= 1
        end_col += 1
        for name in names:
            xrefs.append({
                "name": name,
                "range": make_range(
                    start_node.lineno - 1,
                    start_node.col_offset,
                    end_line,
                    end_col
                )
            })
        pending_xref = None

unops = {
    "UAdd": lambda a: +a,
    "USub": lambda a: -a,
    "Not": lambda a: not a,
    "Invert": lambda a: ~a
}

binops = {
    "Add": lambda a, b: a + b,
    "Sub": lambda a, b: a - b,
    "Mult": lambda a, b: a * b,
    "Div": lambda a, b: a / b,
    "Mod": lambda a, b: a % b,
    "LShift": lambda a, b: a << b,
    "RShift": lambda a, b: a >> b,
    "BitOr": lambda a, b: a | b,
    "BitXor": lambda a, b: a ^ b,
    "BitAnd": lambda a, b: a & b,
    "FloorDiv": lambda a, b: a // b,
    "Pow": lambda a, b: a ** b
}

cmpops = {
    "Eq": lambda a, b: a == b,
    "NotEq": lambda a, b: a != b,
    "Lt": lambda a, b: a < b,
    "LtE": lambda a, b: a <= b,
    "Gt": lambda a, b: a > b,
    "GtE": lambda a, b: a >= b,
    "Is": lambda a, b: a is b,
    "IsNot": lambda a, b: a is not b,
    "In": lambda a, b: a in b,
    "NotIn": lambda a, b: a not in b
}

class ConstantEvaluator(ast.NodeVisitor):
    def visit_UnaryOp(self, op):
        global unops
        a = self.visit(op.operand)
        executor = unops.get(op.op.__class__.__name__)
        if executor is None:
            raise ValueError("unsupported UnaryOp")
        return executor(a)

    def visit_BinOp(self, op):
        global binops
        a = self.visit(op.left)
        b = self.visit(op.right)
        executor = binops.get(op.op.__class__.__name__)
        if executor is None:
            raise ValueError("unsupported BinOp")
        return executor(a, b)

    def visit_BoolOp(self, op):
        is_and = isinstance(op.op, ast.And)
        if not is_and and not isinstance(op.op, ast.Or):
            raise ValueError("unsupported BoolOp")
        last = self.visit(op.values[0])
        for value in op.values[1:]:
            result = self.visit(value)
            if is_and:
                if not result:
                    return last
            elif result:
                return result
            last = result
        return last

    def visit_Compare(self, cmp):
        global cmpops
        left = self.visit(cmp.left)
        for op, right_expr in zip(cmp.ops, cmp.comparators):
            executor = cmpops.get(op.__class__.__name__)
            if executor is None:
                raise ValueError("unsupported Compare")
            right = self.visit(right_expr)
            if not executor(left, right):
                return False
            left = right
        return True

    def visit_Subscript(sub):
        if not isinstance(l.ctx, ast.Load):
            raise ValueError("unsupported context")
        tgt = self.visit(sub.value)
        if isinstance(sub.slice, ast.Slice):
            return tgt[sub.slice.lower:sub.slice.upper:sub.slice.step]
        return tgt[self.visit(sub.slice)]

    def visit_IfExp(self, exp):
        if self.visit(exp.test):
            return self.visit(exp.body)
        return self.visit(exp.orelse)

    def visit_Constant(self, value):
        return value.value

    def visit_Num(self, value):
        return value.n

    def visit_Str(self, value):
        return value.s

    def visit_Name(self, value):
        if value.id == 'True' or value.id == 'False':
            return value.id == 'True'
        ast.NodeVisitor.generic_visit(self, value)

    def visit_JoinedStr(self, jstr):
        return ''.join(self.visit(val) for val in jstr.values)

    def visit_FormattedValue(self, value):
        val = self.visit(value.value)
        if value.conversion == 115:
            val = str(val)
        elif value.conversion == 114:
            val = repr(val)
        elif value.conversion == 97:
            val = ascii(val)
        if value.format_spec is not None:
            val = ('{0:' + value.format_spec + '}').format(val)
        return str(val)

    def visit_List(self, l):
        if not isinstance(l.ctx, ast.Load):
            raise ValueError("unsupported context")
        return [self.visit(val) for val in l.elts]

    def visit_Tuple(self, t):
        if not isinstance(l.ctx, ast.Load):
            raise ValueError("unsupported context")
        return tuple(self.visit(val) for val in t.elts)

    def visit_Set(self, s):
        return set(self.visit(val) for val in s.elts)

    def visit_Dict(self, d):
        return dict(zip(
            (self.visit(k) for k in d.keys),
            (self.visit(v) for v in d.values)
        ))

    def generic_visit(self, node):
        raise ValueError("unsupported construct")

class ImportFinder(ast.NodeVisitor):
    def visit_Import(self, impt):
        global xrefs, pending_xref
        set_loc(impt)
        has_end = hasattr(impt, 'end_lineno') and hasattr(impt, 'end_col_offset')
        if has_end and impt.end_lineno is not None and impt.end_col_offset is not None:
            for alias in impt.names:
                xrefs.append({
                    "name": alias.name,
                    "range": make_range(
                        impt.lineno - 1,
                        impt.col_offset,
                        impt.end_lineno - 1,
                        impt.end_col_offset
                    )
                })
        else:
            pending_xref = [alias.name for alias in impt.names], impt

    def visit_ImportFrom(self, impt):
        global xrefs, pending_xref
        set_loc(impt)
        has_end = hasattr(impt, 'end_lineno') and hasattr(impt, 'end_col_offset')
        if has_end and impt.end_lineno is not None and impt.end_col_offset is not None:
            xrefs.append({
                "name": impt.module,
                "range": make_range(
                    impt.lineno - 1,
                    impt.col_offset,
                    impt.end_lineno - 1,
                    impt.end_col_offset
                )
            })
        else:
            pending_xref = [impt.module], impt

    def visit_Call(self, call):
        global xrefs, pending_xref
        set_loc(call)
        is_import_fn = lambda fn: fn in ('__import__', 'import_module')
        is_importlib = isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'importlib'
        if isinstance(call.func, ast.Name) and is_import_fn(call.func.id) or is_importlib and is_import_fn(call.func.attr):
            # TODO: better relative import resolution
            const_eval = ConstantEvaluator()
            try:
                tgt = None
                for kw in call.keywords:
                    if kw.arg == 'package':
                        tgt = const_eval.visit(kw.arg)
                if tgt is None:
                    tgt = const_eval.visit(call.args[0])
                if not isinstance(tgt, str):
                    raise ValueError("failed to resolve import")
                has_end = hasattr(call, 'end_lineno') and hasattr(call, 'end_col_offset')
                if has_end and call.end_lineno is not None and call.end_col_offset is not None:
                    xrefs.append({
                        "name": tgt,
                        "range": make_range(
                            call.lineno - 1,
                            call.col_offset,
                            call.end_lineno - 1,
                            call.end_col_offset
                        )
                    })
                else:
                    pending_xref = [tgt], call
            except:
                pass
        else:
            ast.NodeVisitor.generic_visit(self, call)

    def generic_visit(self, node):
        if hasattr(node, 'lineno') and hasattr(node, 'col_offset'):
            set_loc(node)
        ast.NodeVisitor.generic_visit(self, node)

err_lineno = -1
err_offset = -1
while True:
    try:
        full_ast = ast.parse(src)
        break
    except SyntaxError as err:
        if err.lineno == err_lineno and err.offset == err_offset:
            sys.exit()
        err_lineno = err.lineno
        err_offset = err.offset
        xrefs = []
        pending_xref = None
        last_colon = False
        arrived = False
        indents = []
        backup_indent = '\\t' if any(line[:1] == '\\t' for line in src_lines) else '    '
        tokens = tokenize.generate_tokens(io.StringIO(src).readline)
        newlines = (token.NEWLINE, token.NL) if hasattr(token, 'NL') else (token.NEWLINE, tokenize.NL)
        for t in tokens:
            if t[2][0] == err_lineno or t[0] in newlines and t[2][0] == err_lineno - 1:
                break
            elif t[0] == token.OP and t[1] == ":":
                last_colon = True
            elif t[0] not in (token.INDENT, token.DEDENT) and t[0] not in newlines:
                last_colon = False
            if t[0] == token.INDENT and (not arrived or last_colon):
                indents.append(t[1])
            elif t[0] == token.DEDENT:
                indents.pop()
        if t[2][0] != err_lineno:
            try:
                next_token = next(tokens)
                if next_token[0] == token.INDENT:
                    if last_colon:
                        indents.append(next_token[1])
                elif last_colon:
                    indents.append(indents[-1] if indents else backup_indent)
            except IndentationError as err:
                indents.pop()
        src_lines[err_lineno - 1] = ''.join(indents) + 'pass'
        src = '\\n'.join(src_lines)

visitor = ImportFinder()
visitor.visit(full_ast)
save_pending_xref(len(src_lines) - 1, len(src_lines[-1]) - 1)
print(json.dumps(xrefs))`]);
            const output = await Promise.race([
                text(proc.stdout),
                new Promise<string>(resolve => setTimeout(() => resolve(''), 1000))
            ]);
            if (!output) return null;
            return JSON.parse(output, (key, value) => {
                if (key === 'range') {
                    return new vscode.Range(
                        new vscode.Position(value.start.line, value.start.character),
                        new vscode.Position(value.end.line, value.end.character)
                    );
                }
                return value;
            });
        } else {
            // fallback for web/whenever Python interpreter not available
            const pyImportRE = /(?<=(?:^|\n)\s*)(?:import\s+(.+?)|from\s+(.+?)\s+import.+?)(?=\s*(?:$|\n))/g;
            const pyDynamicImportRE = /(?:__import__|import_module)\((?:"""(.+?)"""|'''(.+?)'''|"(.+?)"|'(.+?)'|)\)/g;
            let charInd = 0
            const lineChars = src.split('\n').map(line => charInd += line.length + 1);
            let match: RegExpExecArray | null = null;
            for (let nl = 0; match = pyImportRE.exec(src);) {
                while (lineChars[nl] <= match.index) ++nl;
                const names = match[1] ? match[1].split(',').map(v => v.trim()) : match[2];
                const startLine = nl, startCol = match.index - (nl && lineChars[nl - 1]);
                while (lineChars[nl] <= match.index + match[0].length) ++nl;
                const endLine = nl, endCol = match.index - (nl && lineChars[nl - 1]);
                const range = new vscode.Range(startLine, startCol, endLine, endCol);
                for (const name of names) {
                    results.push({ name, range });
                }
            }
            for (let nl = 0; match = pyDynamicImportRE.exec(src);) {
                while (lineChars[nl] <= match.index) ++nl;
                const name = match[1] || match[2] || match[3] || match[4];
                const startLine = nl, startCol = match.index - (nl && lineChars[nl - 1]);
                while (lineChars[nl] <= match.index + match[0].length) ++nl;
                const endLine = nl, endCol = match.index - (nl && lineChars[nl - 1]);
                const range = new vscode.Range(startLine, startCol, endLine, endCol);
                results.push({ name, range });
            }
        }
    } else {
        const basename = path.basename(doc.fileName);
        const globPatterns = await getGlobPatterns();
        if (basename === 'package.json') {
            const pkg = jsonToAST(src, {
                loc: true
            })
            if (pkg.type !== 'Object') {
                return null;
            }
            for (const pkgField of pkg.children) {
                if (pkgField.key.value === 'dependencies' ||
                    pkgField.key.value === 'devDependencies' ||
                    pkgField.key.value === 'peerDependencies' ||
                    pkgField.key.value === 'optionalDependencies'
                ) {
                    if (pkgField.value.type === 'Object') {
                        for (const v of pkgField.value.children) {
                            const { loc } = v;
                            if (loc) {
                                results.push({
                                    name: v.key.value,
                                    range: rangeForJSONAstLoc(loc),
                                    prioritize: true
                                })
                            }
                        }
                    }
                }
                if (pkgField.key.value === 'bundledDependencies') {
                    if (pkgField.value.type === 'Array') {
                        for (const node of pkgField.value.children) {
                            if (node.type === 'Literal' && typeof node.value === 'string') {
                                const {loc} = node
                                if (loc) {
                                    results.push({
                                        name: node.value,
                                        range: rangeForJSONAstLoc(loc)
                                    })
                                }
                            }
                        }
                    }
                }
                if (pkgField.key.value === 'overrides') {
                    if (pkgField.value.type === 'Object') {
                        parsePkgOverrideExternals(pkgField.value, results)
                    }
                }
    
            }
        } else if (basename === 'pyproject.toml') {
            let parsed: toml.AST.TOMLProgram;
            try {
                parsed = toml.parseTOML(src);
            } catch (err) {
                return null;
            }
            traverseTOMLKeys(parsed, (key, path) => {
                const inPoetry = path.length > 2 && 
                    path[0] === 'tool' &&
                    path[1] === 'poetry';
                const oldDep = inPoetry && path.length === 4 &&
                    ['dependencies', 'dev-dependencies'].includes(path[2] as string);
                const groupDep = inPoetry && path.length === 6 &&
                    path[2] === 'group' &&
                    path[4] === 'dependencies';
                if ((oldDep || groupDep) && typeof path[path.length - 1] === 'string') {
                    const loc = key.parent.type === 'TOMLTable' ? key.loc : key.parent.loc;
                    results.push({
                        name: path[path.length - 1] as string,
                        range: new vscode.Range(
                            new vscode.Position(loc.start.line - 1, loc.start.column),
                            new vscode.Position(loc.end.line - 1, loc.end.column)
                        )
                    });
                }
            });
        } else if (basename === 'Pipfile') {
            let parsed: toml.AST.TOMLProgram;
            try {
                parsed = toml.parseTOML(src);
            } catch (err) {
                return null;
            }
            traverseTOMLKeys(parsed, (key, path) => {
                if (
                    path.length === 2 &&
                    ['packages', 'dev-packages'].includes(path[0] as string) &&
                    typeof path[1] === 'string'
                ) {
                    const loc = key.parent.type === 'TOMLTable' ? key.loc : key.parent.loc;
                    results.push({
                        name: path[1] as string,
                        range: new vscode.Range(
                            new vscode.Position(loc.start.line - 1, loc.start.column),
                            new vscode.Position(loc.end.line - 1, loc.end.column)
                        )
                    });
                }
            });
        } else if (micromatch.isMatch(basename, globPatterns.pypi.requirements.pattern)) {
            const commentRE = /(\s|^)#.*/;
            const lines = src.split('\n').map(line => line.replace(commentRE, ''));
            const nameRE = /(?<=^\s*)([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])(?=<|!|>|~|=|@|\(|\[|;|\s|$)/i;
            for (let i = 0; i < lines.length; ++i) {
                const line = lines[i];
                const match = nameRE.exec(line);
                if (match) {
                    results.push({
                        name: match[1],
                        range: new vscode.Range(
                            new vscode.Position(i, match.index),
                            new vscode.Position(i, match.index + line.length)
                        )
                    });
                }
            }
        }
    }
    return results
}
function rangeForJSONAstLoc(loc: Required<jsonToAST.ValueNode>['loc']): vscode.Range {
   return new vscode.Range(
        new vscode.Position(
            loc.start.line - 1,
            loc.start.column - 1
        ),
        new vscode.Position(
            loc.end.line - 1,
            loc.end.column - 1
        )
    )
}
function parsePkgOverrideExternals(node: jsonToAST.ObjectNode, results: Array<ExternalRef>, contextualName?: string): void {
    for (const child of node.children) {
        let pkgName: string | undefined
        if (child.key.value === '.') {
            if (contextualName) {
                pkgName = contextualName
            }
        } else {
            pkgName = getJSPackageNameFromVersionRange(child.key.value);
        }
        if (pkgName) {
            const { loc } = child.value.type === 'Literal' ? child : child.key
            if (loc) {
                results.push({
                    range: rangeForJSONAstLoc(loc),
                    name: pkgName
                })
            }
        }
        const { value } = child
        if (value.type === 'Object') {
            parsePkgOverrideExternals(value, results, pkgName ?? contextualName)
        } else if (value.type === 'Literal') {
            if (typeof value.value === 'string') {
                if (value.value.startsWith('$')) {
                    const { loc } = value;
                    if (loc) {
                        results.push({
                            range: rangeForJSONAstLoc(loc),
                            name: value.value.slice(1)
                        })
                    }
                }
            }
        }
    }
}
