import * as vscode from 'vscode'
import {workspace} from 'vscode'
import ini from 'ini'
import { Octokit } from 'octokit';
import { getWorkspaceFolderURI } from '../util';

function orgOrUserFromString(url: string): string | undefined {
    const ghHTTP = /^(?:git\+)?https?:\/\/(?:www.)?github.com(?::80|:443)?\/(?<target>[^\/\?#]*)(?=\/|$)/u;
    const ghGit = /^(?:git(?:\+ssh)?:\/\/)?(?<user>[^@]+@)?github.com[\/:](?<target>[^\/\?#]*)(?=\/|$)/u;
    const match = ghHTTP.exec(url) || ghGit.exec(url)
    if (match) {
        return match.groups?.target || match.groups?.user
    }
}

/**
 * Looks around a workspace folder root for some configuration that would let us directly
 * install the github app against rather than asking for too much permissions
 * @param workspaceRootURI
 */
async function sniffForGithubOrgOrUser(workspaceRootURI: vscode.Uri): Promise<string | undefined> {
    // package.json repository
    try {
        const pkg = JSON.parse(
            Buffer.from(await workspace.fs.readFile(
                vscode.Uri.joinPath(workspaceRootURI, 'package.json')
            )).toString()
        )
        const repoTopLevel = pkg?.repository
        let url: string
        if (typeof repoTopLevel === 'string') {
            url = repoTopLevel
        } else {
            url = repoTopLevel?.url
        }
        if (url) {
            const found = orgOrUserFromString(url)
            if (found) return found
        }
    } catch (e) {
    }
    // git remotes?
    try {
        const gitConfig = ini.parse(
            Buffer.from(await workspace.fs.readFile(
                vscode.Uri.joinPath(workspaceRootURI, '.git', 'config')
            )).toString()
        )
        for (const key of Object.keys(gitConfig)) {
            if (key.startsWith('remote ')) {
                const url = gitConfig[key].url
                if (url) {
                    const found = orgOrUserFromString(url)
                    if (found) return found
                }
            }
        }
    } catch {}
}

export function installGithubApp(uri: vscode.Uri) {
    vscode.authentication.getSession('github', [
        'read:user',
        'read:org'
    ], {
        createIfNone: true,
    }).then(
        async s => {
            const client = new Octokit({
                auth: s.accessToken,
            })
            let workspaceFolderURI = getWorkspaceFolderURI(uri)
            if (!workspaceFolderURI) {
                // can't be smart, just open it
                workspaceFolderURI = vscode.Uri.joinPath(uri, '.')
            }
            const orgOrUser = await sniffForGithubOrgOrUser(workspaceFolderURI)
            const currentUser = await client.rest.users.getAuthenticated()
            let id
            if (currentUser.data.login === orgOrUser) {
                id = currentUser.data.id
            } else {
                const userOrgs = await client.rest.orgs.listForAuthenticatedUser()
                const matchingOrg = userOrgs.data.find(org => {
                    return org.login === orgOrUser
                })
                if (matchingOrg) {
                    id = matchingOrg.id
                }
            }
            if (id) {
                vscode.env.openExternal(
                    vscode.Uri.parse(
                        `https://github.com/apps/socket-security/installations/new/permissions?target_id=${id}`
                    )
                )
            } else {
                vscode.env.openExternal(
                    vscode.Uri.parse(
                        `https://github.com/apps/socket-security/installations/new/`
                    )
                )
            }
        },
        () => {
            // user did not want to use vscode auth
            vscode.env.openExternal(
                vscode.Uri.parse(
                    `https://github.com/apps/socket-security/installations/new/`
                )
            )
        }
    )
}
