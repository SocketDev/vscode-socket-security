
import ast
import io
import json
import os
import sys
import token
import tokenize

# Optional imports with guards for Python 2.7+ compatibility
try:
    import importlib
except ImportError:
    importlib = None

try:
    import pkgutil
except ImportError:
    pkgutil = None


# Collect paths
stdlib_path = os.path.dirname(os.__file__)


# Built-in modules
builtin_modules = set(sys.builtin_module_names)

# Standard library modules
if pkgutil is not None:
    stdlib_modules = set(
        module.name for module in pkgutil.iter_modules([stdlib_path])
    )
else:
    stdlib_modules = set()

src = sys.stdin.read()
src_lines = src.split(u'\\n')

def ImportReference(name, start_line, start_col, end_line, end_col):
    return {
        "name": find_distribution_for_module(name),
        "is_builtin": (name in stdlib_modules) or (name in builtin_modules),
        "range": {
            "start": {"line": start_line, "character": start_col},
            "end": {"line": end_line, "character": end_col}
        }
    }

xrefs = []
pending_xref = None


def get_module_file_path(module_name):
    # Preferred: Python 3.4+
    try:
        if importlib is not None:
            try:
                import importlib.util
                spec = importlib.util.find_spec(module_name)
                if spec and spec.origin:
                    return spec.origin
            except (ImportError, AttributeError):
                pass
    except Exception:
        pass

    # Fallback for Python 2.7+
    try:
        if pkgutil is not None:
            loader = pkgutil.get_loader(module_name)
            if loader:
                try:
                    return loader.get_filename()
                except AttributeError:
                    pass
    except Exception:
        pass

    try:
        mod = __import__(module_name)
        mod_path = getattr(mod, '__file__', None)
        return mod_path
    except Exception:
        return None



def find_distribution_for_module(module_name):
    # Step 1: Dynamically import the module
    try:
        mod_path = get_module_file_path(module_name)
        if not mod_path:
            return module_name
    except ImportError:
        return module_name
    except Exception:
        return module_name

    # Step 2: Try importlib.metadata (Python 3.8+)
    metadata = None
    try:
        import importlib
        try:
            import importlib.metadata as metadata
        except ImportError:
            try:
                import importlib_metadata as metadata  # type: ignore # Backport (optional)
            except ImportError:
                metadata = None
    except ImportError:
        pass

    if metadata is not None:
        try:
            for dist in metadata.distributions():
                try:
                    if any(str(file) in mod_path for file in getattr(dist, 'files', []) or []):
                        return dist.metadata['Name']
                except Exception:
                    continue
        except Exception:
            pass  # Be safe around possibly buggy metadata

    # Step 3: Fallback to pkg_resources (setuptools)
    try:
        import pkg_resources
        for dist in pkg_resources.working_set:
            if dist.location and mod_path.startswith(dist.location):
                return dist.project_name
    except ImportError:
        pass

    return module_name

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
            xrefs.append(
                ImportReference(
                    name,
                    start_node.lineno - 1,
                    start_node.col_offset,
                    end_line,
                    end_col
                )
            )
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
                xrefs.append(ImportReference(alias.name,
                        impt.lineno - 1,
                        impt.col_offset,
                        impt.end_lineno - 1,
                        impt.end_col_offset
                    ))
        else:
            pending_xref = [alias.name for alias in impt.names], impt

    def visit_ImportFrom(self, impt):
        global xrefs, pending_xref
        set_loc(impt)
        has_end = hasattr(impt, 'end_lineno') and hasattr(impt, 'end_col_offset')
        if has_end and impt.end_lineno is not None and impt.end_col_offset is not None:
            xrefs.append(ImportReference(impt.module,
                    impt.lineno - 1,
                    impt.col_offset,
                    impt.end_lineno - 1,
                    impt.end_col_offset
                ))
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
                    xrefs.append(ImportReference(tgt,
                            call.lineno - 1,
                            call.col_offset,
                            call.end_lineno - 1,
                            call.end_col_offset
                        ))
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
            if err_lineno is None:
                pass
            elif t[2][0] == err_lineno or t[0] in newlines and t[2][0] == err_lineno - 1:
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


# Guard for importlib usage in remapping
try:
    if importlib is not None:
        metadata = importlib.import_module("importlib.metadata")
        namemap = metadata.packages_distributions()
    else:
        namemap = {}
except Exception:
    namemap = {}

remapped_xrefs = []
for xref in xrefs:
    print(xref, file=sys.stderr)
    top_pkg = xref["name"].split(".")[0]
    for name in namemap.get(top_pkg, [top_pkg]):
        print(f"Remapping {xref['name']} to {name}", file=sys.stderr)
        copied_xref = dict(xref)
        copied_xref["name"] = name
        remapped_xrefs.append(copied_xref)
print(json.dumps(remapped_xrefs))
