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

export type IssueRules = Record<string, boolean | {
    action: 'error' | 'warn' | 'ignore' | 'defer'
}>

export type APIConfig = {
    apiKey: string;
    enforcedRules: IssueRules;
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

type OrgInfo = {
    id: string
    name: string
    image: string | null
    plan: 'opensource' | 'team' | 'enterprise'
}

type OrgResponse = {
    organizations: Record<string, OrgInfo>
}

type KeyEntry = {
    start: string | null
    settings: Record<string, {
        deferTo: string | null
        issueRules: IssueRules
    }>
}

type KeyResponse = {
    defaults: {
        issueRules: IssueRules
    }
    entries: KeyEntry[]
}


type KeyInfo = {
    organizations: Record<string, OrgInfo & {
        issueRules: IssueRules
    }>
    defaultIssueRules: IssueRules
}

async function getSettings(apiKey: string): Promise<KeyInfo | null> {
    const authHeader = toAuthHeader(apiKey)
    const orgReq = https.get('https://api.socket.dev/v0/organizations', {
        method: 'GET',
        headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json'
        }
    })
    const [orgRes] = await once(orgReq, 'response') as [IncomingMessage]
    if (orgRes.statusCode !== 200) return null
    const orgs: OrgResponse = JSON.parse(await text(orgRes))
    const req = https.request('https://api.socket.dev/v0/settings', {
        method: 'POST',
        headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json'
        }
    })
    const orgIDs = Object.keys(orgs.organizations)
    req.end(JSON.stringify(orgIDs.map(organization => ({ organization }))))
    const [res] = await once(req, 'response') as [IncomingMessage]
    if (res.statusCode !== 200) return null
    const keyData: KeyResponse = JSON.parse(await text(res))
    return {
        organizations: Object.fromEntries(
            orgIDs.map((orgID, i) => {
                const entry = keyData.entries[i]
                let issueRules: IssueRules = {}
                let target = entry.start
                while (target !== null) {
                    issueRules = mergeDefaults(issueRules, entry.settings[target].issueRules)
                    target = entry.settings[target].deferTo
                }
                return [orgID, {
                    ...orgs.organizations[orgID],
                    issueRules
                }]
            })
        ),
        defaultIssueRules: keyData.defaults.issueRules
    }
}

export function ruleStrength (rule: IssueRules[string]): 0 | 1 | 2 | 3 {
    if (typeof rule === 'boolean') return rule ? 3 : 1
    switch (rule.action) {
        case 'error': return 3
        case 'warn': return 2
        case 'ignore': return 1
        case 'defer': return 0
    }
}

export function mergeRules(a: IssueRules, b: IssueRules) {
    const merged = { ...a }
    for (const rule in b) {
        if (!(rule in merged) || ruleStrength(b[rule]) > ruleStrength(merged[rule])) {
            merged[rule] = b[rule]
        }
    }
    return merged
}

export function mergeDefaults (a: IssueRules, b: IssueRules) {
    const merged = { ...a }
    for (const rule in b) {
        const defaultedRule = merged[rule]
        if (
            !(rule in merged) || (
            typeof defaultedRule === 'object' &&
            defaultedRule.action === 'defer'
        )) {
            merged[rule] = b[rule]
        }
    }
    return merged
}

/**
 * Used to generate the completely resolved maximally constrained issue rule values for all applied policies.
 */
function getConfigFromSettings(apiKey: string, settings: KeyInfo, enforcedOrgs: string[]): APIConfig {
    const enforcedRules: IssueRules = enforcedOrgs
        .map(org => settings.organizations[org]?.issueRules)
        .filter(rules => rules)
        .reduce((a, b) => mergeRules(a, b), {})

  
    return {
        apiKey,
        enforcedRules,
        defaultRules: settings.defaultIssueRules,
        orgRules: Object.values(settings.organizations).map(({ id, name, issueRules }) => {
            return {
                id,
                name,
                issueRules: mergeDefaults(issueRules, settings.defaultIssueRules)
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
                apiConf = getConfigFromSettings(settings.apiKey, keyInfo, settings.enforcedOrgs)
                if (update) changeAPIConf.fire()
            }
        }
    } catch (err) {}
}

async function findAPIConfig () {
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
        if (!(apiConf as APIConfig).apiKey) await loadConfig()
    }
    return (apiConf as APIConfig).apiKey ? apiConf as APIConfig : null
}

let existingFindCall: Promise<APIConfig | null> | null = null

export async function getExistingAPIConfig() {
    if (existingFindCall) return existingFindCall
    existingFindCall = findAPIConfig()
    const result = await existingFindCall
    existingFindCall = null
    return result
}

export async function usePublicConfig (force?: boolean) {
    if (force || !getExistingAPIConfig()) {
        const apiKey = PUBLIC_TOKEN
        const keyInfo = (await getSettings(apiKey))!
        await saveConfig(apiKey, [])
        apiConf = getConfigFromSettings(apiKey, keyInfo, [])
        changeAPIConf.fire()
    }
    return apiConf as APIConfig
}

export async function getAPIConfig(force?: boolean) {
    if (!force) {
        const existingConf = await getExistingAPIConfig()
        if (existingConf) return existingConf
    }
    let keyInfo: KeyInfo
    let apiKey = await vscode.window.showInputBox({
        title: 'Socket Security API Token',
        placeHolder: 'Leave this blank to use a public token',
        prompt: 'Enter your API token from https://socket.dev/',
        async validateInput (value) {
            if (!value) return
            keyInfo = (await getSettings(value))!
            if (!keyInfo) return 'Invalid API key'
        }
    })
    if (apiKey === undefined) return null
    let enforcedOrgs: string[] = []
    if (!apiKey) {
        apiKey = PUBLIC_TOKEN
        keyInfo = (await getSettings(apiKey))!
    } else {
        const enforceableOrgs: { label: string; id: string | null }[] = Object.values(keyInfo!.organizations)
            .filter(item => item.plan === 'enterprise')
            .map(item => ({
                label: item.name,
                id: item.id
            }))
        if (enforceableOrgs.length) {
            const result = await vscode.window.showQuickPick(enforceableOrgs.concat({
                label: 'None',
                id: null
            }), {
                title: 'Which organization\'s policies should Socket enforce system-wide?'
            })
            if (result?.id) enforcedOrgs = [result.id]
        }
    }
    await saveConfig(apiKey, enforcedOrgs)
    apiConf = getConfigFromSettings(apiKey, keyInfo!, enforcedOrgs)
    changeAPIConf.fire()
    return apiConf as APIConfig
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