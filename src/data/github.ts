import * as vscode from 'vscode'
import { getStaticParsed, parse as parseToml } from 'toml-wasm'
import ini from 'ini'

export function orgOrUserFromString(url: string): string | undefined {
  const ghHTTP =
    /^(?:git\+)?https?:\/\/(?:www.)?github.com(?::443|:80)?\/(?<target>[^/?#]*)(?=\/|$)/u // socket-hook: allow regex-alternation-order
  const ghGit =
    /^(?:git(?:\+ssh)?:\/\/)?(?<user>[^@]+@)?github.com[/:](?<target>[^/?#]*)(?=\/|$)/u // socket-hook: allow regex-alternation-order
  const match = ghHTTP.exec(url) || ghGit.exec(url)
  if (match) {
    return match.groups?.['target'] || match.groups?.['user']
  }
}

/**
 * Looks around a workspace folder root for some configuration that would let us directly
 * install the github app against rather than asking for too much permissions
 * @param workspaceRootURI
 */
export async function sniffForGithubOrgOrUser(
  workspaceRootURI: vscode.Uri,
): Promise<string | undefined> {
  // package.json repository
  try {
    const pkg = JSON.parse(
      Buffer.from(
        await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(workspaceRootURI, 'package.json'),
        ),
      ).toString(),
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
  } catch (e) {}

  // poetry in pyproject.toml
  try {
    const pyproject = getStaticParsed(
      parseToml(
        Buffer.from(
          await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(workspaceRootURI, 'pyproject.toml'),
          ),
        ).toString(),
      ),
    ) as {
      tool?: {
        poetry?: {
          repository?: string
        }
      }
    }
    const url = pyproject.tool?.poetry?.repository
    if (url) {
      const found = orgOrUserFromString(url)
      if (found) return found
    }
  } catch (e) {}

  // git remotes?
  try {
    const gitConfig = ini.parse(
      Buffer.from(
        await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(workspaceRootURI, '.git', 'config'),
        ),
      ).toString(),
    )
    const keys = Object.keys(gitConfig)
    for (let i = 0, { length } = keys; i < length; i += 1) {
      const key = keys[i]!
      if (key.startsWith('remote ')) {
        const url = gitConfig[key]?.url
        if (url) {
          const found = orgOrUserFromString(url)
          if (found) return found
        }
      }
    }
  } catch (e) {}
}
