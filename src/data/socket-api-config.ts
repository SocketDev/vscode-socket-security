import * as vscode from 'vscode'
import * as path from 'node:path'
import * as os from 'node:os'
import * as https from 'node:https'
import { once } from 'node:events'
import { IncomingMessage } from 'node:http'
import { text } from 'node:stream/consumers'
import constants from '@socketsecurity/registry/lib/constants'
import { addDisposablesTo } from '../util'
import { log } from 'node:console'

const { SOCKET_PUBLIC_API_TOKEN } = constants

export type APIConfig = {
    apiKey: string
}

let apiConf: APIConfig | undefined

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

type OrganizationsRecord = {
    organizations: Record<string, OrgInfo>
}

async function getOrganizations(apiKey: string): Promise<OrganizationsRecord | null> {
    const authHeader = toAuthHeader(apiKey)
    const orgReq = https.get('https://api.socket.dev/v0/organizations', {
        method: 'GET',
        headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json'
        }
    })
    const [orgRes] = await once(orgReq, 'response') as [IncomingMessage]
    if (orgRes.statusCode !== 200) {
        return null
    }
    const orgs: OrganizationsRecord = JSON.parse(await text(orgRes))
    return orgs
}

/**
 * Used to generate the completely resolved maximally constrained issue rule values for all applied policies.
 */
function getConfigFromSettings(apiKey: string): APIConfig {
    return {
        apiKey,
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
            const keyInfo = await getOrganizations(settings.apiKey)
            if (!keyInfo) {
                await saveConfig(null, null)
            } else {
                apiConf = getConfigFromSettings(settings.apiKey)
                if (update) changeAPIConf.fire()
            }
        }
    } catch (err) { }
}

async function findAPIConfig() {
    if (!apiConf) {
        apiConf = undefined
        let keyInfo: OrganizationsRecord | null
        const envKey = process.env.SOCKET_SECURITY_API_TOKEN ?? process.env.SOCKET_SECURITY_API_KEY
        if (envKey) {
            keyInfo = await getOrganizations(envKey)
            apiConf = {
                apiKey: envKey
            }
        } else {
            await loadConfig()
        }
    }
    return (apiConf as APIConfig)?.apiKey ? apiConf as APIConfig : null
}

let existingFindCall: Promise<APIConfig | null> | null = null

export async function getExistingAPIConfig() {
    if (existingFindCall) return existingFindCall
    existingFindCall = findAPIConfig()
    const result = await existingFindCall
    existingFindCall = null
    return result
}

let pendingNewConfig: Promise<APIConfig | null> | null = null
export async function getAPIConfig() {
    const existingConf = await getExistingAPIConfig()
    if (existingConf) {
        return existingConf
    }
    if (pendingNewConfig) {
        return pendingNewConfig
    }
    async function getNewConfig() {
        let organizations: OrganizationsRecord
        let apiKey = null
        while (true) {
            const loginChoice = await vscode.window.showInformationMessage('Socket Security requires authentication for full functionality.',
                'Authenticate',
                'Stay logged out'
            )
            // they chose to ignore the prompt or opted to be logged out
            // it will come back later
            if (loginChoice === 'Stay logged out' || !loginChoice) {
                break
            }
            if (loginChoice === 'Authenticate') {
                apiKey = await vscode.window.showInputBox({
                    title: 'Socket Security API Token',
                    placeHolder: 'Leave this blank to stay logged out',
                    prompt: 'Enter your API token from https://socket.dev/',
                    async validateInput(value) {
                        if (!value) return
                        organizations = (await getOrganizations(value))!
                        if (!organizations) return 'Invalid API key'
                    }
                })
                // vscode gives undefined if focus is lost, this is error prone UX
                // show the informative message again that they can ignore
                // only consider the user to have made a choice if they enter a value
                if (typeof apiKey === 'string') {
                    break
                }
            }
        }
        let enforcedOrgs: string[] = []
        if (!apiKey || apiKey === SOCKET_PUBLIC_API_TOKEN) {
            // dont save to disk and don't ask for orgs
            apiConf = {
                apiKey: SOCKET_PUBLIC_API_TOKEN
            }
            changeAPIConf.fire()
            return apiConf
        } else {
            let organizationsList = Object.values(organizations!.organizations!)
            if (organizationsList.length) {
                (organizationsList[0] as OrgInfo)
                const options: (vscode.QuickPickItem & { id: string | null })[] = [
                    ...organizationsList.map(org => {
                        return {
                            label: org.name,
                            id: org.id,
                        }
                    }),
                    {
                        label: 'None',
                        id: null
                    }
                ]
                const result = await vscode.window.showQuickPick(options, {
                    title: 'Which organization\'s policies should Socket enforce system-wide?'
                })
                if (result?.id) enforcedOrgs = [result.id]
            }
        }
        await saveConfig(apiKey, enforcedOrgs)
        apiConf = getConfigFromSettings(apiKey)
        changeAPIConf.fire()
        return apiConf
    }
    pendingNewConfig = getNewConfig()
    pendingNewConfig.finally(() => {
        pendingNewConfig = null
    })
    return pendingNewConfig
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
            apiConf = undefined
        })
    )
}

const changeAPIConf = new vscode.EventEmitter<void>()
export const onAPIConfChange = changeAPIConf.event
