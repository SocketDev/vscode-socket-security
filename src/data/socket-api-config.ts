import * as vscode from 'vscode'
import * as path from 'node:path'
import * as os from 'node:os'
import * as https from 'node:https'
import { once } from 'node:events'
import { IncomingMessage } from 'node:http'
import { text } from 'node:stream/consumers'
import { addDisposablesTo } from '../util'

// TODO: dedupe with CLI - consolidate into SDK

const PUBLIC_TOKEN = 'sktsec_t_--RAN5U4ivauy4w37-6aoKyYPDt5ZbaT5JBVMqiwKo_api'

type IssueRules = Record<string, boolean | {
    action: 'error' | 'warn' | 'ignore' | 'defer'
}>

export type APIConfig = {
    apiKey: string;
    defaultRules: IssueRules;
    orgRules: { id: string; name: string; issueRules: IssueRules }[]
}

let apiConf: APIConfig | {} | undefined


let dataHome = process.platform === 'win32'
  ? process.env['LOCALAPPDATA']
  : process.env['XDG_DATA_HOME']

if (!dataHome) {
  if (process.platform === 'win32') throw new Error('missing %LOCALAPPDATA%')
  const home = os.homedir()
  dataHome = path.join(home, ...(process.platform === 'darwin'
    ? ['Library', 'Application Support']
    : ['.local', 'share']
  ))
}

const settingsPath = path.join(dataHome, 'socket', 'settings')

export function toAuthHeader(apiKey: string) {
    return `Basic ${Buffer.from(`${apiKey}:`).toString('base64url')}`
}

type KeyInfo = {
    organizations: Record<string, {
        id: string
        name: string
        plan: { tier: 'opensource' | 'team' | 'enterprise' }
        issueRules: IssueRules
    }>
    defaultIssueRules: IssueRules
}

async function getSettings(apiKey: string): Promise<KeyInfo | null> {
    const req = https.get('https://api.socket.dev/v0/settings', {
        headers: {
            Authorization: toAuthHeader(apiKey)
        }
    })
    const [res] = await once(req, 'response') as [IncomingMessage]
    if (res.statusCode !== 200) return null
    return JSON.parse(await text(res))
}

function getConfigFromSettings(apiKey: string, settings: KeyInfo, enforcedOrgs: string[]): APIConfig {    
    const ruleStrength = (rule: IssueRules[string]) => {
        if (typeof rule === 'boolean') return rule ? 3 : 1
        switch (rule.action) {
            case 'error': return 3
            case 'warn': return 2
            case 'ignore': return 1
            case 'defer': return 0
        }
    }

    const mergeRules = (a: IssueRules, b: IssueRules) => {
        const merged = { ...a }
        for (const rule in b) {
            if (
                !merged[rule] ||
                ruleStrength(b[rule]) > ruleStrength(merged[rule])
            ) {
                merged[rule] = b[rule]
            }
        }
        return merged
    }

    const mergeDefaults = (rules: IssueRules) => {
        const out = { ...rules }
        for (const rule in settings.defaultIssueRules) {
            const defaultedRule = out[rule]
            if (
                !(rule in out) || (
                typeof defaultedRule === 'object' &&
                defaultedRule.action === 'defer'
            )) {
                out[rule] = settings.defaultIssueRules[rule]
            }
        }
        return out
    }

    const enforcedRules: IssueRules = enforcedOrgs
        .map(org => settings.organizations[org]?.issueRules)
        .filter(rules => rules)
        .reduce((a, b) => mergeRules(a, b))

  
    return {
        apiKey,
        defaultRules: mergeDefaults(enforcedRules),
        orgRules: Object.values(settings.organizations as Record<string, {
            id: string;
            name: string;
            issueRules: IssueRules;
        }>).map(({ id, name, issueRules }) => {
            return {
                id,
                name,
                issueRules: mergeDefaults(mergeRules(issueRules, enforcedRules))
            }
        })
    }
}

async function saveConfig(apiKey: string | null, enforcedOrgs: string[] | null) {
    await vscode.workspace.fs.writeFile(
        vscode.Uri.file(settingsPath),
        Buffer.from(Buffer.from(JSON.stringify({ apiKey, enforcedOrgs })).toString('base64'))
    )
}

async function loadConfig(update?: boolean) {
    try {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath))
        const settings = JSON.parse(Buffer.from(Buffer.from(buf).toString(), 'base64').toString())
        if (settings.apiKey) {
            const keyInfo = await getSettings(settings.apiKey)
            if (!keyInfo) {
                await saveConfig(null, null)
            } else {
                apiConf = getConfigFromSettings(settings.apiKey, keyInfo, settings.enforcedOrgs) || {}
                if (update) changeAPIConf.fire()
            }
        }
    } catch (err) {}
}

export async function getExistingAPIConfig() {
    if (!apiConf) {
        apiConf = {}
        let keyInfo: KeyInfo | null
        const envKey = process.env.SOCKET_SECURITY_API_KEY
        if (envKey) {
            keyInfo = await getSettings(envKey)
            if (keyInfo) {
                apiConf = getConfigFromSettings(envKey, keyInfo, [])
            }
        }
        if (!apiConf) await loadConfig()
    }
    
    return (apiConf as APIConfig).apiKey ? (apiConf as APIConfig) : null
}

export async function getAPIConfig(force?: boolean) {
    if (!force) {
        const existingConf = await getExistingAPIConfig()
        if (existingConf) return existingConf
    }
    let keyInfo: KeyInfo
    const rawKey = await vscode.window.showInputBox({
        title: 'Socket Security API Token',
        placeHolder: 'Leave this blank to use a public token',
        prompt: 'Enter your API token from https://socket.dev/',
        async validateInput (value) {
            if (!value) return
            keyInfo = (await getSettings(value))!
            if (!keyInfo) return 'Invalid API key'
        }
    })
    let apiKey = rawKey
    if (!apiKey) {
        apiKey = PUBLIC_TOKEN
        keyInfo = (await getSettings(apiKey))!
    }
    const enforceableOrgs: { label: string; id: string | null }[] = Object.values(keyInfo!.organizations)
        .filter(item => item.plan.tier === 'enterprise')
        .map(item => ({
            label: item.name,
            id: item.id
        }))
    let enforcedOrgs: string[] = []
    if (enforceableOrgs.length) {
        const result = await vscode.window.showQuickPick(enforceableOrgs.concat({
            label: 'None',
            id: null
        }), {
            title: 'Which organization\'s policies should Socket enforce system-wide?'
        })
        if (result?.id) enforcedOrgs = [result.id]
    }
    await saveConfig(apiKey, enforcedOrgs)
    apiConf = getConfigFromSettings(apiKey, keyInfo!, enforcedOrgs)
    changeAPIConf.fire()
    return apiConf
}

export function init(disposables?: vscode.Disposable[]) {
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
            path.dirname(settingsPath),
            path.basename(settingsPath)
        )
    )
    addDisposablesTo(
        disposables,
        watcher,
        watcher.onDidChange(() => loadConfig(true)),
        watcher.onDidCreate(() => loadConfig(true)),
        watcher.onDidDelete(() => {
            apiConf = {}
        })
    )
}

const changeAPIConf = new vscode.EventEmitter<void>();
export const onAPIConfChange = changeAPIConf.event;