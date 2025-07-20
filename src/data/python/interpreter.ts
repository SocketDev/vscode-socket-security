import * as vscode from 'vscode'
import { EXTENSION_PREFIX } from '../../util'
import { PythonExtension } from '@vscode/python-extension';

async function getPythonExtension() {
    const msPython = vscode.extensions.getExtension('ms-python.python')
    if (msPython && !msPython.isActive) await msPython.activate()
    return msPython?.exports
}

// TODO: defer to python interpreter to provide this list
const builtins = new Set([
    "__future__",
    "__hello__",
    "__phello__",
    "_abc",
    "_aix_support",
    "_ast",
    "_codecs",
    "_collections",
    "_collections_abc",
    "_compat_pickle",
    "_compression",
    "_functools",
    "_imp",
    "_io",
    "_locale",
    "_markupbase",
    "_operator",
    "_osx_support",
    "_py_abc",
    "_pydatetime",
    "_pydecimal",
    "_pyio",
    "_pylong",
    "_signal",
    "_sitebuiltins",
    "_sre",
    "_stat",
    "_string",
    "_strptime",
    "_symtable",
    "_sysconfigdata__darwin_darwin",
    "_thread",
    "_threading_local",
    "_tokenize",
    "_tracemalloc",
    "_typing",
    "_warnings",
    "_weakref",
    "_weakrefset",
    "abc",
    "aifc",
    "antigravity",
    "argparse",
    "ast",
    "asyncio",
    "atexit",
    "base64",
    "bdb",
    "bisect",
    "builtins",
    "bz2",
    "cProfile",
    "calendar",
    "cgi",
    "cgitb",
    "chunk",
    "cmd",
    "code",
    "codecs",
    "codeop",
    "collections",
    "colorsys",
    "compileall",
    "concurrent",
    "configparser",
    "contextlib",
    "contextvars",
    "copy",
    "copyreg",
    "crypt",
    "csv",
    "ctypes",
    "curses",
    "dataclasses",
    "datetime",
    "dbm",
    "decimal",
    "difflib",
    "dis",
    "doctest",
    "email",
    "encodings",
    "ensurepip",
    "enum",
    "errno",
    "faulthandler",
    "filecmp",
    "fileinput",
    "fnmatch",
    "fractions",
    "ftplib",
    "functools",
    "gc",
    "genericpath",
    "getopt",
    "getpass",
    "gettext",
    "glob",
    "graphlib",
    "gzip",
    "hashlib",
    "heapq",
    "hmac",
    "html",
    "http",
    "idlelib",
    "imaplib",
    "imghdr",
    "importlib",
    "inspect",
    "io",
    "ipaddress",
    "itertools",
    "json",
    "keyword",
    "lib2to3",
    "linecache",
    "locale",
    "logging",
    "lzma",
    "mailbox",
    "mailcap",
    "marshal",
    "mimetypes",
    "modulefinder",
    "multiprocessing",
    "netrc",
    "nntplib",
    "ntpath",
    "nturl2path",
    "numbers",
    "opcode",
    "operator",
    "optparse",
    "os",
    "pathlib",
    "pdb",
    "pickle",
    "pickletools",
    "pipes",
    "pkgutil",
    "platform",
    "plistlib",
    "poplib",
    "posix",
    "posixpath",
    "pprint",
    "profile",
    "pstats",
    "pty",
    "pwd",
    "py_compile",
    "pyclbr",
    "pydoc",
    "pydoc_data",
    "queue",
    "quopri",
    "random",
    "re",
    "reprlib",
    "rlcompleter",
    "runpy",
    "sched",
    "secrets",
    "selectors",
    "shelve",
    "shlex",
    "shutil",
    "signal",
    "site",
    "smtplib",
    "sndhdr",
    "socket",
    "socketserver",
    "sqlite3",
    "sre_compile",
    "sre_constants",
    "sre_parse",
    "ssl",
    "stat",
    "statistics",
    "string",
    "stringprep",
    "struct",
    "subprocess",
    "sunau",
    "symtable",
    "sys",
    "sysconfig",
    "tabnanny",
    "tarfile",
    "telnetlib",
    "tempfile",
    "test",
    "textwrap",
    "this",
    "threading",
    "time",
    "timeit",
    "tkinter",
    "token",
    "tokenize",
    "tomllib",
    "trace",
    "traceback",
    "tracemalloc",
    "tty",
    "turtle",
    "turtledemo",
    "types",
    "typing",
    "unittest",
    "urllib",
    "uu",
    "uuid",
    "venv",
    "warnings",
    "wave",
    "weakref",
    "webbrowser",
    "wsgiref",
    "xdrlib",
    "xml",
    "xmlrpc",
    "zipapp",
    "zipfile",
    "zipimport",
    "zoneinfo"
])
export function isPythonBuiltin(name: string) {
    return builtins.has(name)
}

export async function initPython(): Promise<vscode.Disposable> {
    const ext = await getPythonExtension()
    if (ext) {
        return ext.environments.onDidChangeActiveEnvironmentPath((e: unknown) => {
            changeMSPython.fire()
        })
    }
    return new vscode.Disposable(() => { })
}

const warned = new Set<string>()
export async function getPythonInterpreter(doc?: vscode.TextDocument): Promise<{ execPath: string } | null> {
    let execPath: string = 'python'
    let usingSystemPath = true
    const workspaceConfig = vscode.workspace.getConfiguration(EXTENSION_PREFIX)
    const pathOverride = workspaceConfig.get<string>('pythonInterpreter')
    if (pathOverride) {
        try {
            const st = await vscode.workspace.fs.stat(vscode.Uri.file(pathOverride))
            if (st.type & vscode.FileType.File) {
                usingSystemPath = false
                execPath = pathOverride
            }
        } catch {
        }
        if (usingSystemPath) {
            vscode.window.showErrorMessage(`Failed to find Python binary at '${pathOverride}'. Please update ${EXTENSION_PREFIX}.pythonInterpreter.`)
        }
    }
    if (usingSystemPath) {
        const ext: PythonExtension = await PythonExtension.api();
        if (ext) {

            const env = await ext.environments.resolveEnvironment(
                ext.environments.getActiveEnvironmentPath(doc ? doc.uri : undefined)
            )
            if (env) {
                usingSystemPath = false
                execPath = env.executable.uri?.fsPath || env.executable.sysPrefix || env.executable.uri?.path || ''
            } else {
                // TODO: make this less noisy
                // warnToInstallMoreReliablePython(ext);
            }
        }
    }
    return {
        execPath
    }
}
function warnToInstallMoreReliablePython(ext: vscode.Extension<any>) {
    const workspaceConfig = vscode.workspace.getConfiguration(EXTENSION_PREFIX)
    const workspaceID = vscode.workspace.name ||
        vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(',') ||
        vscode.window.activeTextEditor?.document.uri.fsPath
    if (workspaceID) {
        if (warned.has(workspaceID)) return
        warned.add(workspaceID)
    }
    const installPython = 'Install Python extension'
    const configPython = 'Configure Python extension'
    const setPath = `Configure Socket`
    vscode.window.showErrorMessage(
        `Socket failed to find a Python installation; please ${ext ? 'pick an interpreter within' : 'install'} the Python extension or set ${EXTENSION_PREFIX}.pythonInterpreter.`,
        ext ? configPython : installPython,
        setPath
    ).then(async res => {
        if (res === installPython) {
            vscode.env.openExternal(vscode.Uri.parse('vscode:extension/ms-python.python'))
        } else if (res === configPython) {
            vscode.commands.executeCommand('python.setInterpreter')
        } else if (res === setPath) {
            await workspaceConfig.update('pythonInterpreter', '', vscode.ConfigurationTarget.Global)
            vscode.commands.executeCommand('workbench.action.openSettingsJson')
        }
    })
}

const changeMSPython = new vscode.EventEmitter<void>()
export const onMSPythonInterpreterChange = changeMSPython.event
