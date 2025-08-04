import * as vscode from 'vscode';
import { parseExternals, SimPURL } from './externals/parse-externals'
import { PURLDataCache } from './purl-alerts-and-scores/manager'
import { PackageScoreAndAlerts } from './purl-alerts-and-scores/manager'
import { isGoBuiltin } from '../data/go/builtins'
import logger from '../infra/log'
import { PURLPackageData } from './purl-alerts-and-scores/manager';
import { SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER } from './languages';
import { isPythonBuiltin } from '../data/python/interpreter';
import * as Module from 'module';
import { getGlobPatterns } from '../data/glob-patterns'

export async function activate(context: vscode.ExtensionContext) {
    const decoManager = new DecorationManager(context);
    for (const lang of Object.keys(SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER)) {
        vscode.languages.registerHoverProvider({
            language: lang,
        }, {
            provideHover(document, position) {
                return decoManager.docManagers.get(document.uri.toString() as TextDocumentURIString)?.provideHover(document, position);
            }
        })
    }
    const patterns = await getGlobPatterns();
    for (const [group, patternsForGroup] of Object.entries(patterns)) {
        for (const [name, {pattern}] of Object.entries(patternsForGroup)) {
            vscode.languages.registerHoverProvider({
                // language: 'json',
                pattern,
            }, {
                provideHover(document, position) {
                    return decoManager.docManagers.get(document.uri.toString() as TextDocumentURIString)?.provideHover(document, position);
                }
            })  
         }
    }
}
class DecorationTypes {
    informativeDecoration: vscode.TextEditorDecorationType
    warningDecoration: vscode.TextEditorDecorationType
    errorDecoration: vscode.TextEditorDecorationType
    constructor(context: vscode.ExtensionContext) {
    this.errorDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: {
            margin: '0 0 0 2rem',
            contentIconPath: vscode.Uri.file(context.asAbsolutePath('logo-red.svg')),
            width: '12px',
            height: '12px',
        },
    });
    // logger.debug('Created error decoration', this.errorDecoration.key);
    this.warningDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: {
            margin: '0 0 0 2rem',
            contentIconPath: vscode.Uri.file(context.asAbsolutePath('logo-yellow.svg')),
            width: '12px',
            height: '12px',
        },
    });
    // logger.debug('Created warning decoration', this.warningDecoration.key);
    this.informativeDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true
    });
    // logger.debug('Created informative decoration', this.informativeDecoration.key);
}
}

class DecorationManager {
    docManagers: Map<TextDocumentURIString, DecorationManagerForDocument> = new Map();
    docChangeWatchers: vscode.Disposable
    docCloseWatchers: vscode.Disposable
    docOpenWatchers: vscode.Disposable
    editorChangeWatchers: vscode.Disposable
    purlManagers: DecorationManagerForPURLCache

    constructor(context: vscode.ExtensionContext) {
        const decorationTypes = new DecorationTypes(context);
        this.purlManagers = new DecorationManagerForPURLCache(decorationTypes);
        function updateDoc(doc: vscode.TextDocument) {
            const docURI = doc.uri.toString() as TextDocumentURIString;
            if (docURI.startsWith('output:')) {
                return; // ignore output documents
            }
            let manager = managerForDoc(docURI);
            manager.update(doc)
        }
        const managerForDoc = (docURI: TextDocumentURIString) => {
            let manager = this.docManagers.get(docURI);
            if (!manager) {
                manager = new DecorationManagerForDocument(docURI, decorationTypes, this.purlManagers);
                this.docManagers.set(docURI, manager);
            }
            return manager;
        }
        for (const editor of vscode.window.visibleTextEditors) {
            const docURI = editor.document.uri.toString() as TextDocumentURIString;
            const manager = managerForDoc(docURI);
            manager.update(editor.document);
        }
        this.docChangeWatchers = vscode.workspace.onDidChangeTextDocument((doc) => {
            // TODO: track if change could affect externals and only decorate then
            let hasMeaningfulChange = false;
            if (!hasMeaningfulChange) {
                for (const docChange of doc.contentChanges) {
                    if (docChange.rangeLength !== 0) {
                        hasMeaningfulChange = true;
                        break
                    }
                    if (docChange.text && docChange.text !== '') {
                        hasMeaningfulChange = true;
                        break
                    }
                }
            }
            if (!hasMeaningfulChange) {
                return; // no meaningful change, skip
            }
            updateDoc(doc.document);
        })
        this.docCloseWatchers = vscode.workspace.onDidCloseTextDocument((doc) => {
            const docURI = doc.uri.toString() as TextDocumentURIString
            this.docManagers.get(docURI)?.currentDocUpdate.abort();
            this.docManagers.delete(docURI);
        })
        this.docOpenWatchers = vscode.workspace.onDidOpenTextDocument((doc) => {
            updateDoc(doc);
        });
        this.editorChangeWatchers = vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) {
                const docURI = editor.document.uri.toString() as TextDocumentURIString;
                const manager = managerForDoc(docURI);
                manager.decorateEditor(editor);
            }
        })
    }

    dispose() {
        for (const manager of this.docManagers.values()) {
            manager.currentDocUpdate.abort();
        }
    }
}
class DecorationManagerForPURLCache {
    purlManagers: Map<SimPURL, DecorationManagerForPURL> = new Map()
    decorationTypes: DecorationTypes;
    constructor(decorationTypes: DecorationTypes) {
        this.decorationTypes = decorationTypes;
    }
    for(purl: SimPURL) {
        let manager = this.purlManagers.get(purl);
        if (!manager) {
            manager = new DecorationManagerForPURL(purl, this.decorationTypes);
            this.purlManagers.set(purl, manager);
        }
        return manager;
    }
}

let isNodeBuiltin: (name: string) => boolean = Module.isBuiltin

let isBuiltin = (name: string, eco: string): boolean => {
    if (eco === 'npm') return isNodeBuiltin(name);
    if (eco === 'pypi') return isPythonBuiltin(name);
    if (eco === 'go') return isGoBuiltin(name);
    return false;
}

let isLocalPackage = (name: string, eco: string): boolean => {
    if (eco === 'npm') {
        return name.startsWith('.') || name.startsWith('/') || name.startsWith('#')
    }
    if (eco === 'pypi') return name.startsWith('.')
    if (eco === 'go') {
        const parts = name.split('/')
        return parts.some(p => p.startsWith('.')) || !parts[0].includes('.') ||
            !/[a-z0-9][a-z0-9.-]*/.test(parts[0])
    }
    return false;
}
class DecorationManagerForPURL {
    documentManagersForDocumentsWithThisPURL: Set<DecorationManagerForDocument> = new Set();
    subscribe(manager: DecorationManagerForDocument): void {
        this.documentManagersForDocumentsWithThisPURL.add(manager);
    }
    unsubscribe(manager: DecorationManagerForDocument): void {
        this.documentManagersForDocumentsWithThisPURL.delete(manager);
    }
    purl: SimPURL;
    packageData: PURLPackageData | null = null;
    decorationType: vscode.TextEditorDecorationType;
    decorationTypes: DecorationTypes;
    isBuiltin: boolean;
    isLocalPackage: boolean;
    subscriptionCallback?: (data: PURLPackageData) => void;
    constructor(purl: SimPURL, decorationTypes: DecorationTypes) {
        this.purl = purl;
        this.decorationTypes = decorationTypes;
        this.decorationType = this.decorationTypes.informativeDecoration;
        const { eco, name } = getPURLParts(purl);
        // we don't need to watch for builtin or local packages
        this.isBuiltin = isBuiltin(name, eco)
        this.isLocalPackage = isLocalPackage(name, eco);
        if (this.isBuiltin || this.isLocalPackage) {
            return
        }
        this.subscriptionCallback = ((data) => {
            this.packageData = data;
            this.#eagerDecoration();
            for (const manager of this.documentManagersForDocumentsWithThisPURL) {
                manager.markDirty(manager.currentDocUpdate.signal);
            }
        });
        const watcher = PURLDataCache.singleton.watch(this.purl)
        this.subscriptionCallback(watcher);
        watcher.subscribe(this.subscriptionCallback);
    }
    linkForPURL(data: PURLPackageData): string {
        const pkgData = data?.pkgData;
        if (!pkgData) {
            return `[${this.purl} $(link-external)](https://socket.dev/${this.purl})`
        }
        let type = pkgData.type
        let version = `/overview/${pkgData.version}`
        if (type === 'golang') {
            type = 'go'
            version = `?section=overview&version=${pkgData.version}`
        }
        return `[${pkgData.name} $(link-external)](https://socket.dev/${type}/package/${pkgData.namespace ? pkgData.namespace + '/' : ''}${pkgData.name}${version})`
    }
    dispose() {
        if (this.subscriptionCallback) {
            PURLDataCache.singleton.watch(this.purl).unsubscribe(this.subscriptionCallback);
        }
    }
    async generateHoverMarkdown(): Promise<vscode.MarkdownString> {
        if (this.isBuiltin) {
            return new vscode.MarkdownString(`Socket Security for ${this.purl} : Builtin package`, true);
        } else if (this.isLocalPackage) {
            return new vscode.MarkdownString(`Socket Security for ${this.purl} : Local package (likely installed as an alias)`, true);
        }
        const data = this.packageData
        if (!data) {
            return new vscode.MarkdownString(`&hellip; fetching Socket Security for ${this.purl} &hellip;`, true);
        }
        const pkgData = data?.pkgData;
        if (!pkgData) {
            if (data.error) {
                return new vscode.MarkdownString(`Socket Security for ${this.linkForPURL(data)}: ${data.error}`, true);
            } else {
                return new vscode.MarkdownString(`&hellip; fetching Socket Security for ${this.linkForPURL(data)} &hellip;`, true);
            }
        }
        const { score: { overall: depscore } } = pkgData;
        const { eco, name } = getPURLParts(this.purl)!
        const depscoreStr = (depscore * 100).toFixed(0)
        const groupedAlerts = Object.groupBy(pkgData.alerts, alert => alert.action)

        function rowsForGrouping(actionGroupedAlertSet: PackageScoreAndAlerts['alerts'] | undefined): string {
            if (!actionGroupedAlertSet) {
                return ''
            }
            let ret: string[] = [];
            let color = (hex: string, text: string) => `<span style="color:${hex};">${text}</span>`;
            // TODO: better grouping since there can be *MANY* alerts of the same type
            // this is a bit lossy, but better than noise
            let typesListed = new Set<string>();
            for (const alert of actionGroupedAlertSet) {
                let extra = color('#888888', '&nbsp;');
                if (alert.props?.alternatePackage) {
                    extra = `Possible intent: [${name} $(link-external)](https://socket.dev/${eco}/package/${name})`
                } else if (alert.props?.lastPublish) {
                    const lastPublish = new Date(alert.props.lastPublish).toLocaleDateString();
                    extra = `Last published on: ${lastPublish}`;
                } else if (typesListed.has(alert.type)) {
                    continue
                }
                typesListed.add(alert.type);
                const rowColor = {
                    'error': '#ff8800',
                    'warn': '#cc8800',
                    'monitor': '#aaaa00',
                    'ignore': '#888888',
                }[alert.action]
                ret.push([alert.action, alert.type, extra].map(
                    (str) => color(rowColor, str) // color the action column
                ).join(' | '));
            }
            return ret.join('\n')
        }
        const hoverMessage = new vscode.MarkdownString(`
Socket Security for ${this.linkForPURL(data)} (package score: ${depscoreStr})

----

action | type | extra
------ | ---- | -----
${([
    'error', 'warn', 'monitor', 'ignore'
] as const).flatMap(
    action => {
        const alertsForAction = groupedAlerts[action]
        if (!alertsForAction || alertsForAction.length === 0) {
            return ''
        }
        return rowsForGrouping(alertsForAction)+'\n'
    }
).join('')}
`, true);
        // logger.error(`Generated hover message for ${this.purl}`, hoverMessage.value);
        hoverMessage.supportHtml = true;
        hoverMessage.isTrusted = true;
        return hoverMessage
    }
    /**
     * These must be eager so that they give squigglies etc.
     * @returns /
     */
    #eagerDecoration() {
        const data = this.packageData
        const decorationTypes = this.decorationTypes;
        const pkgData = data?.pkgData;
        if (!pkgData) {
            if (data?.error) {
                // this can happen if the package is private etc. don't be too noisy
                this.decorationType = decorationTypes.informativeDecoration;
            } else {
                this.decorationType = decorationTypes.informativeDecoration;
            }
            return
        }
        const { alerts } = pkgData;
        this.decorationType = decorationTypes.informativeDecoration
        for (const {action} of alerts) {
            if (action === 'error') {
                this.decorationType = decorationTypes.errorDecoration
                break;
            } else if (action === 'warn') {
                this.decorationType = decorationTypes.warningDecoration
            }
        }
    }
}
class DecorationManagerForDocument {
    externalRefs: Map<SimPURL, {ranges: vscode.Range[]}> = new Map();
    currentDocUpdate: AbortController = new AbortController
    isDirty: boolean = false;
    docURI: TextDocumentURIString;
    // parameterized, shared across all instances
    decorationTypes: DecorationTypes;
    // parameterized, shared across all instances
    purlManagers: DecorationManagerForPURLCache
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        for (const [purl, {ranges}] of this.externalRefs) {
            for (const range of ranges) {
                const intersects = range.contains(position)
                // logger.warn(document.getText(range), 'hovering over range', range, 'for purl', purl, 'intersects:', intersects, 'at position', position);
                if (intersects) {
                    const purlManager = this.purlManagers.for(purl);
                    const hoverMessage = await purlManager.generateHoverMarkdown();
                    if (!hoverMessage) {
                        // logger.warn(`No hover message for PURL ${purl}, skipping hover`);
                        return undefined;
                    }
                    return new vscode.Hover(hoverMessage, range);
                }
            }
        }
    }
    constructor(docURI: TextDocumentURIString, decorationTypes: DecorationTypes, purlManagers: DecorationManagerForPURLCache) {
        this.docURI = docURI;
        this.decorationTypes = decorationTypes;
        this.purlManagers = purlManagers
    }
    async update(doc: vscode.TextDocument) {
        const docURI = doc.uri.toString() as TextDocumentURIString;
        if (this.docURI !== docURI) {
            return
        }
        // We cannot skip updates if the editor isn't visible since there are some goofy cases
        // like when the editor is previewing another or preloading
        this.currentDocUpdate.abort();
        this.currentDocUpdate = new AbortController();
        const thisDocUpdateSignal = this.currentDocUpdate.signal;
        let externals;
        try {
            externals = await parseExternals(doc);
        } catch {}
        if (!externals) return;
        logger.debug(`Parsed externals for ${docURI}:`, externals.size, 'externals found, aborted:', thisDocUpdateSignal.aborted);
        logger.debug([...externals.keys()].join(', '));
        if (thisDocUpdateSignal.aborted) {
            console.info(`Decoration update for ${docURI} was aborted (parsing externals took longer than next update), skipping.`);
            return;
        }
        let isDirty = this.externalRefs.size !== externals.size;
        if (!isDirty) {
            check_each_purl_is_same_ranges:
            for (const [purl, {ranges}] of externals) {
                const existing = this.externalRefs.get(purl);
                if (!existing) {
                    isDirty = true;
                    break;
                }
                if (existing.ranges.length !== ranges.length) {
                    isDirty = true;
                    break;
                }
                for (let i = 0; i < existing.ranges.length; i++) {
                    if (!ranges[i].isEqual(existing.ranges[i])) {
                        isDirty = true;
                        break check_each_purl_is_same_ranges;
                    }
                }
            }
        }
        this.externalRefs = externals;
        this.isDirty = isDirty
        for (const purl of this.externalRefs.keys()) {
            this.purlManagers.for(purl).subscribe(this)
        }
        // this should hold true due to no await above, defensive check here
        if (!thisDocUpdateSignal.aborted) {
            if (this.isDirty) {
                this.markDirty(thisDocUpdateSignal);
            }
        }
    }
    async markDirty(thisDocUpdateSignal: AbortSignal) {
        this.isDirty = true;
        await this.#decorateEverything(thisDocUpdateSignal);
    }
    decorations: Map<vscode.TextEditorDecorationType, vscode.Range[]> = new Map()
    createDecorations() {
        const newDecorations: typeof this['decorations'] = new Map();
        for (const [purl, {ranges}] of this.externalRefs) {
            const purlManager = this.purlManagers.for(purl);
            if (!purlManager.decorationType) {
                logger.warn(`No decoration type for PURL ${purl}, skipping decoration creation`);
                continue
            }
            let pool = newDecorations.get(purlManager.decorationType)
            if (!pool) {
                pool = [...ranges]
                newDecorations.set(purlManager.decorationType, pool);
            } else {
                pool.push(...ranges);
            }
        }
        this.decorations = newDecorations
    }
    /**
     * This will START decorating the document, but since scores / alerts are fetched asynchronously
     * This needs to do checks to see if the decoration request is still valid.
     * This also needs to be able to handle streaming updates to the decorations and failures
     * Each PURL will fetch its own score/alerts from cache in parallel and then update the decorations
     */
    async #decorateEverything(thisDecorationUpdateSignal = this.currentDocUpdate.signal) {
        if (!this.isDirty) return;
        let pending = [];
        logger.debug(`Updating decorations for ${this.docURI} with externals:`, this.externalRefs.size, 'externals found');
        for (const editor of vscode.window.visibleTextEditors) {
            const editorURI = editor.document.uri.toString() as TextDocumentURIString;
            if (editorURI === this.docURI) {
                logger.debug(`Matching editor ${editorURI} for decoration update`);
                pending.push(editor)
            }
        }
        if (pending.length === 0) {
            logger.debug(`No editors found for ${this.docURI}, skipping decoration update`);
            return;
        }
        this.createDecorations();
        await Promise.all(
            pending.map(editor => this.decorateEditor(editor, thisDecorationUpdateSignal))
        )
        if (thisDecorationUpdateSignal.aborted) return
        this.isDirty = false
    }
    async decorateEditor(editor: vscode.TextEditor, thisDecorationUpdate: AbortSignal = this.currentDocUpdate.signal) {
        if (thisDecorationUpdate.aborted) {
            return;
        }
        for (const decorationType of Object.values(this.decorationTypes)) {
            editor.setDecorations(decorationType, this.decorations.get(decorationType) ?? []);
        }
    }
}
const getPURLParts = (purl: SimPURL) => {
    const groups = /^pkg:(?<eco>[^\/]+)\/(?<name>.*)$/v.exec(purl)?.groups
    return (groups as {
        eco: string;
        name: string;
    }) ?? { eco: 'unknown', name: 'unknown' }
}
/**
 * VSCode makes strong guarantee about 1<->1 text document URI to TextDocument mapping.
 */
type TextDocumentURIString = string & { __textDocumentURI: never };
