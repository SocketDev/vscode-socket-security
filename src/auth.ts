import vscode from 'vscode'
import os from 'node:os'
import path from 'node:path'
import { DIAGNOSTIC_SOURCE_STR, EXTENSION_PREFIX } from './util'
import { SOCKET_PUBLIC_API_TOKEN } from '@socketsecurity/lib/constants/socket'
import https from 'node:https'
import { once } from 'node:events'
import { IncomingMessage } from 'node:http'
import { text } from 'node:stream/consumers'
import crypto from 'node:crypto'
export type APIConfig = {
  apiKey: string
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

type SettingsFile = {
  apiKey?: string
  [key: string]: unknown
}

export async function activate(
  context: vscode.ExtensionContext,
  disposables: vscode.Disposable[],
) {
  //#region file path/watching
  // responsible for watching files to know when to sync from disk
  let dataHome =
    process.platform === 'win32'
      ? process.env['LOCALAPPDATA']
      : process.env['XDG_DATA_HOME']

  if (!dataHome) {
    if (process.platform === 'win32') throw new Error('missing %LOCALAPPDATA%')
    const home = os.homedir()
    dataHome = path.join(
      home,
      ...(process.platform === 'darwin'
        ? ['Library', 'Application Support']
        : ['.local', 'share']),
    )
  }
  const pleaseLoginStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  )
  pleaseLoginStatusBar.hide()
  pleaseLoginStatusBar.text = `$(warning) Socket Security: Login`
  pleaseLoginStatusBar.tooltip =
    'Socket Security needs to login for full functionality'
  pleaseLoginStatusBar.command = `${EXTENSION_PREFIX}.login`

  const defaultSettingsPath = path.join(dataHome, 'socket', 'settings')
  const settingsPath = vscode.workspace
    .getConfiguration(EXTENSION_PREFIX)
    .get('settingsFile', defaultSettingsPath)
  //#endregion
  //#region session sync
  // responsible for keeping disk an mem in sync
  let liveSessions: Map<
    vscode.AuthenticationSession['accessToken'],
    vscode.AuthenticationSession
  > = new Map()
  const diskSessionsChanges =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      path.dirname(settingsPath),
      path.basename(settingsPath),
    ),
  )
  disposables?.push(
    watcher,
    watcher.onDidChange(() => syncLiveSessionFromDisk()),
    watcher.onDidCreate(() => syncLiveSessionFromDisk()),
    watcher.onDidDelete(() => {
      syncLiveSessionFromDisk()
    }),
  )
  async function readExistingSettings(): Promise<SettingsFile> {
    try {
      const existingContent = await vscode.workspace.fs.readFile(
        vscode.Uri.file(settingsPath),
      )
      const decoded = Buffer.from(
        new TextDecoder().decode(existingContent),
        'base64',
      ).toString('utf8')
      const parsed = JSON.parse(decoded)
      if (parsed && typeof parsed === 'object' && parsed !== null) {
        return parsed
      }
    } catch {
      // File doesn't exist or is invalid
    }
    return {}
  }
  async function syncLiveSessionFromDisk() {
    let settings_on_disk: { apiKey?: string } = {}
    try {
      const fromDisk = JSON.parse(
        Buffer.from(
          new TextDecoder().decode(
            await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath)),
          ),
          'base64',
        ).toString('utf8'),
      )
      if (fromDisk && typeof fromDisk === 'object' && fromDisk !== null) {
        settings_on_disk = fromDisk
      }
    } catch {}
    const { apiKey } = settings_on_disk
    const sessionOnDisk: typeof liveSessions = new Map<
      vscode.AuthenticationSession['accessToken'],
      vscode.AuthenticationSession
    >()
    if (
      typeof apiKey === 'string' &&
      apiKey.length > 0 &&
      apiKey !== SOCKET_PUBLIC_API_TOKEN
    ) {
      const organizations = await getOrganizations(apiKey)
      const org = Object.values(organizations!.organizations)[0]
      if (org) {
        sessionOnDisk.set(apiKey, sessionFromAPIKey(apiKey, org))
      }
    }
    const added: vscode.AuthenticationSession[] = []
    const changed: vscode.AuthenticationSession[] = []
    const removed: vscode.AuthenticationSession[] = []
    // oxlint-disable-next-line socket/prefer-cached-for-loop -- iterating a Map's values iterator.
    for (const diskSession of sessionOnDisk.values()) {
      // already have this access token in mem session
      // remove from live sessions that haven't been sorted
      if (liveSessions.has(diskSession.accessToken)) {
        liveSessions.delete(diskSession.accessToken)
      } else {
        added.push(diskSession)
      }
    }
    // oxlint-disable-next-line socket/prefer-cached-for-loop -- iterating a Map's values iterator.
    for (const liveSessionWithoutDiskSession of liveSessions.values()) {
      removed.push(liveSessionWithoutDiskSession)
    }
    liveSessions = sessionOnDisk
    if (added.length + changed.length + removed.length > 0) {
      diskSessionsChanges.fire({
        added,
        changed,
        removed,
      })
    }
  }
  async function syncLiveSessionToDisk(session: vscode.AuthenticationSession) {
    if (
      !session ||
      !session.accessToken ||
      session.accessToken === SOCKET_PUBLIC_API_TOKEN
    ) {
      return
    }

    // Read existing settings to preserve other fields (merge approach)
    const existingSettings = await readExistingSettings()

    // Merge new apiKey into existing settings
    existingSettings.apiKey = session.accessToken

    const contents = Buffer.from(JSON.stringify(existingSettings)).toString(
      'base64',
    )
    return vscode.workspace.fs.writeFile(
      vscode.Uri.file(settingsPath),
      new TextEncoder().encode(contents),
    )
  }
  //#endregion
  //#region service glue
  const service = vscode.authentication.registerAuthenticationProvider(
    `${EXTENSION_PREFIX}`,
    `${DIAGNOSTIC_SOURCE_STR}`,
    {
      onDidChangeSessions(fn) {
        return diskSessionsChanges.event(fn)
      },
      async getSessions(
        _scopes: readonly string[] | undefined,
        _options: vscode.AuthenticationProviderSessionOptions,
      ): Promise<vscode.AuthenticationSession[]> {
        return Array.from(liveSessions.values())
      },
      async createSession(
        _scopes: readonly string[],
        _options: vscode.AuthenticationProviderSessionOptions,
      ): Promise<vscode.AuthenticationSession> {
        let organizations: OrganizationsRecord
        const apiKey: string =
          (await vscode.window.showInputBox({
            title: 'Socket Security API Token',
            placeHolder: 'Leave this blank to stay logged out',
            ignoreFocusOut: true,
            prompt: 'Enter your API token from https://socket.dev/',
            async validateInput(value) {
              if (!value) return
              organizations = (await getOrganizations(value))!
              if (!organizations) return 'Invalid API key'
            },
          })) ?? ''
        if (!apiKey) {
          throw new Error('User did not want to provide an API key')
        }
        const org = Object.values(organizations!.organizations)[0]
        if (!org) {
          throw new Error('No organization found for the provided API key')
        }
        const session = sessionFromAPIKey(apiKey, org)
        const oldSessions = Array.from(liveSessions.values())
        await syncLiveSessionToDisk(session)
        liveSessions = new Map([[apiKey, session]])
        pleaseLoginStatusBar.hide()
        diskSessionsChanges.fire({
          added: [session],
          changed: [],
          removed: oldSessions,
        })
        return session
      },
      async removeSession(sessionId: string): Promise<void> {
        const session = liveSessions.get(sessionId)
        try {
          pleaseLoginStatusBar.show()
        } catch {}
        try {
          // Read existing settings to preserve other fields
          const existingSettings = await readExistingSettings()

          // Remove only the apiKey field, preserving other settings
          delete existingSettings.apiKey

          // If there are other settings remaining, write them back; otherwise delete the file
          if (Object.keys(existingSettings).length > 0) {
            const contents = Buffer.from(
              JSON.stringify(existingSettings),
            ).toString('base64')
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(settingsPath),
              new TextEncoder().encode(contents),
            )
          } else {
            // No other settings, safe to delete the entire file
            await vscode.workspace.fs.delete(vscode.Uri.file(settingsPath))
          }
        } catch {}
        if (session) {
          diskSessionsChanges.fire({
            added: [],
            changed: [],
            removed: [session],
          })
        }
      },
    },
  )
  context.subscriptions.push(service)
  vscode.commands.registerCommand(`${EXTENSION_PREFIX}.login`, async () => {
    // The getSession call is intentionally side-effect-only: passing
    // `createIfNone: true` triggers the login flow if no session
    // exists; we don't need the returned session here.
    await vscode.authentication.getSession(`${EXTENSION_PREFIX}`, [], {
      createIfNone: true,
    })
  })
  try {
    await syncLiveSessionFromDisk()
  } catch {}
  let session
  try {
    session = await vscode.authentication.getSession(
      `${EXTENSION_PREFIX}`,
      [],
      {
        createIfNone: false,
      },
    )
  } catch {}
  if (!session) {
    pleaseLoginStatusBar.show()
  }
  //#endregion
  return {}
}

export async function getAPIKey() {
  const session = await vscode.authentication.getSession(
    `${EXTENSION_PREFIX}`,
    [],
    {
      createIfNone: false,
    },
  )
  if (session) {
    return session?.accessToken
  } else {
    return SOCKET_PUBLIC_API_TOKEN
  }
}

export function getAuthHeader(apiKey: string) {
  return `Bearer ${apiKey}`
}

export async function getOrganizations(
  apiKey: string,
): Promise<OrganizationsRecord | undefined> {
  const authHeader = getAuthHeader(apiKey)
  const orgReq = https.get('https://api.socket.dev/v0/organizations', {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  })
  const [orgRes] = (await once(orgReq, 'response')) as [IncomingMessage]
  if (orgRes.statusCode !== 200) {
    return undefined
  }
  const orgs: OrganizationsRecord = JSON.parse(await text(orgRes))
  return orgs
}

export function sessionFromAPIKey(apiKey: string, org: OrgInfo) {
  // vscode auth does weird caching based upon ids
  // if we don't change the id various things stop working
  // like logging in and out with same account/api token
  const uniqueId = `${apiKey}-${crypto.randomUUID()}`
  return {
    accessToken: apiKey,
    id: `${uniqueId}.session`,
    account: {
      id: `${apiKey}.account`,
      label: `${org.name} (${org.plan})`,
    },
    scopes: [],
  }
}
