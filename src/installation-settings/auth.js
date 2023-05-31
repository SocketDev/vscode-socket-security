import https from "https";
import { sniffForGithubOrgOrUser } from "../data/github";
import watchers, { paths } from "../fs-watchers";
import vscode from "vscode";
import { EXTENSION_PREFIX } from "../util";
import { once } from "events";
const socketConfigUri = paths["config/socket/config.json"];
let session = null;
// limited and very scoped API Key
const PUBLIC_ACCESS_API_KEY = "sktsec_t_--RAN5U4ivauy4w37-6aoKyYPDt5ZbaT5JBVMqiwKo_api";
const AuthOperatingModes = {
    /**
     * Sends up data anonymously, data may be persisted indefinitely
     */
    OPEN_SOURCE: "OPEN_SOURCE",
    /**
     * Sends up data associated with a login, data may be persisted indefinitely
     */
    LOGIN: "LOGIN",
    /**
     * Prevents actions requiring a login
     */
    DISABLED: "DISABLED",
    /**
     * Need user interaction, probably should prompt
     */
    UNDEFINED: "UNDEFINED",
};
export async function activate(context) {
    function getOperatingMode() {
        return (context.globalState.get("auth.operatingMode") ??
            AuthOperatingModes.UNDEFINED);
    }
    function setOperatingMode(mode) {
        return context.globalState.update("auth.operatingMode", mode);
    }
    function authSessionForToken(token) {
        return {
            accessToken: token,
            account: {
                id: token,
                label: token === PUBLIC_ACCESS_API_KEY
                    ? `Socket Security Unauthorized (data public, features limited)`
                    : `Socket Security User ${token}`,
            },
            id: token,
            scopes: [],
        };
    }
    async function setSession(token, persist = true) {
        if (persist)
            await writeLogin(token);
        let newSession = null;
        if (token !== null) {
            newSession = authSessionForToken(token);
            if (session && newSession.accessToken === session?.accessToken) {
                return session;
            }
        }
        let added = [];
        let removed = [];
        if (newSession) {
            added.push(newSession);
        }
        if (session) {
            removed.push(session);
        }
        session = newSession;
        const whenKey = `${EXTENSION_PREFIX}.showLogout`;
        await vscode.commands.executeCommand("setContext", whenKey, Boolean(session));
        sessionEE.fire({
            added,
            changed: [],
            removed,
        });
        return session;
    }
    const settingsEE = new vscode.EventEmitter();
    let settingsPromise = null;
    /**
     * Will aggregate concurrent fetches
     */
    function readSettings() {
        return settingsPromise ?? newSettingsPromise();
        async function newSettingsPromise() {
            try {
                const buff = (await vscode.workspace.fs.readFile(socketConfigUri)).toString();
                const contents = JSON.parse(buff);
                settingsEE.fire(contents);
                return contents;
            }
            finally {
                settingsPromise = null;
            }
        }
    }
    async function readAPIKey() {
        let SOCKET_SECURITY_API_KEY = (await readSettings()).auth?.apiKey ?? null;
        // type check for forwards compat
        if (SOCKET_SECURITY_API_KEY === null)
            return;
        if (typeof SOCKET_SECURITY_API_KEY !== "string") {
            throw new TypeError('expected setting auth.apiKey to be a string or null');
        }
        setSession(SOCKET_SECURITY_API_KEY, false);
    }
    const encoder = new TextEncoder();
    async function writeLogin(newAPIKey) {
        let contents = null;
        try {
            const buff = await vscode.workspace.fs.readFile(socketConfigUri);
            try {
                contents = JSON.parse(buff.toString());
            }
            catch (e) { }
        }
        catch (e) {
            contents = {};
        }
        if (!contents) {
            throw new Error("unable to login due to corrupted settings");
        }
        contents.SOCKET_SECURITY_API_KEY = newAPIKey;
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(socketConfigUri, ".."));
        await vscode.workspace.fs.writeFile(socketConfigUri, encoder.encode(JSON.stringify(contents)));
    }
    watchers["config/socket/config.json"].watch({
        onDidChange(e) {
            readAPIKey();
        },
        onDidCreate(e) {
            readAPIKey();
        },
        onDidDelete(e) {
            readAPIKey();
        },
    });
    await readAPIKey();
    vscode.commands.registerCommand(`${EXTENSION_PREFIX}.logout`, async () => {
        await setSession(null, true);
        vscode.window.showInformationMessage("Successfully signed out.");
    });
    vscode.commands.registerCommand(`${EXTENSION_PREFIX}.login`, async () => {
        await setSession(null, false);
        vscode.authentication.getSession(`${EXTENSION_PREFIX}`, [], {
            createIfNone: true,
        });
    });
    const sessionEE = new vscode.EventEmitter();
    vscode.authentication.registerAuthenticationProvider(`${EXTENSION_PREFIX}`, "Socket.dev", {
        async getSessions(scopes = []) {
            const existing = session ? [session] : [];
            return existing;
        },
        async createSession(scopes) {
            if (scopes && scopes.length) {
                throw new Error("Only Single Login Allowed");
            }
            let workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!workspaceFolder) {
                const legacyRootPath = vscode.workspace.rootPath;
                if (legacyRootPath) {
                    workspaceFolder = vscode.Uri.parse(legacyRootPath);
                }
            }
            let acct = null;
            if (workspaceFolder) {
                const orgOrUser = await sniffForGithubOrgOrUser(workspaceFolder);
                if (orgOrUser) {
                    acct = `gh/${orgOrUser}`;
                }
            }
            const options = {
                gotoDashboard: `Go to socket.dev dashboard and copy API key`,
                manuallyEnter: "Manually enter socket.dev API key",
                publicAccess: "Run anonymously",
                disable: "Disable functionality requiring authentication",
            };
            let token = null;
            const workflow = await vscode.window.showQuickPick(Object.values(options), {
                canPickMany: false,
                ignoreFocusOut: true,
                title: "Select socket.dev extension operating mode",
            });
            if (workflow === options.gotoDashboard ||
                workflow === options.manuallyEnter) {
                if (workflow === options.gotoDashboard) {
                    const browser_URI = vscode.Uri.parse(acct
                        ? `https://socket.dev/dashboard/org/${acct}/settings/api`
                        : `https://socket.dev/dashboard`);
                    await vscode.env.openExternal(browser_URI);
                }
                token = await vscode.window.showInputBox({
                    ignoreFocusOut: true,
                    placeHolder: `$API_TOKEN`,
                    prompt: acct
                        ? `Please enter a socket.dev API token for: ${acct}`
                        : `Please enter a socket.dev API token`,
                    title: "System socket.dev login",
                    async validateInput(value) {
                        return null;
                        if (!value) {
                            const msg = {
                                message: "please fill in the value",
                                severity: vscode.InputBoxValidationSeverity.Error,
                            };
                            return msg;
                        }
                        const req = https.get("https://socket.dev/api/v0/quota");
                        req.end();
                        let valid = false;
                        try {
                            const [res] = await once(req, "response");
                            valid = res.statusCode === 200;
                        }
                        catch { }
                        if (!valid) {
                            const msg = {
                                message: "unable to validate API token against socket.dev",
                                severity: vscode.InputBoxValidationSeverity.Error,
                            };
                            return msg;
                        }
                        return null;
                    },
                    password: true,
                });
                await setOperatingMode(AuthOperatingModes.LOGIN);
                if (token) {
                    const loggedInSession = await setSession(token, true);
                    if (loggedInSession) {
                        ;
                        (async () => {
                            const reaction = await vscode.window.showInformationMessage(`Successfully logged into socket.dev`, "logout", "ok");
                            if (reaction === "logout") {
                                this.removeSession(loggedInSession.id);
                            }
                        })();
                        return loggedInSession;
                    }
                }
                vscode.window.showInformationMessage(`Cancelled login into socket.dev`);
                throw new Error(`Cancelled login into socket.dev`);
            }
            else if (workflow === options.publicAccess) {
                const token = PUBLIC_ACCESS_API_KEY;
                const operatingMode = AuthOperatingModes.OPEN_SOURCE;
                await setOperatingMode(operatingMode);
                return authSessionForToken(token);
            }
            else if (workflow === options.disable) {
                const token = "";
                const operatingMode = AuthOperatingModes.OPEN_SOURCE;
                await setOperatingMode(operatingMode);
                return authSessionForToken(token);
            }
            throw new Error("unknown operating mode");
        },
        async removeSession(sessionId) {
            if (session && session.id === sessionId) {
                setSession(null, true);
            }
        },
        onDidChangeSessions(fn) {
            return sessionEE.event(fn);
        },
    }, {
        supportsMultipleAccounts: false,
    });
}
//# sourceMappingURL=auth.js.map