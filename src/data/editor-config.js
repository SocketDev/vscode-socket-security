import * as vscode from 'vscode';
/**
 * @example
 *
 * ```js
 * const api = activate(ctx)
 * const [minIssueLevel, showAllIssueTypes] = api.getConfigValues([`${EXTENSION_PREFIX}.minIssueLevel`, `${EXTENSION_PREFIX}.showAllIssueTypes`])
 * ```
 * @param context
 * @returns
 */
export function activate(context) {
    const watchers = new Map();
    function setupOnConfigChange() {
        if (onDidChangeConfigurationDisposable) {
            const i = context.subscriptions.lastIndexOf(onDidChangeConfigurationDisposable);
            if (i >= 0) {
                context.subscriptions.splice(i, 1);
            }
        }
        onDidChangeConfigurationDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
            let fired = new Set();
            for (const section of watchers.keys()) {
                if (e.affectsConfiguration(section)) {
                    const listeners = watchers.get(section);
                    if (listeners) {
                        for (const listener of listeners) {
                            if (fired.has(listener))
                                continue;
                            fired.add(listener);
                            fireListener(listener);
                        }
                    }
                }
            }
        });
        context.subscriptions.push(onDidChangeConfigurationDisposable);
    }
    let onDidChangeConfigurationDisposable = null;
    function getValuesForListener(listener) {
        return getConfigValues(listener.sections);
    }
    function fireListener(listener) {
        const values = getValuesForListener(listener);
        try {
            listener.fn(values);
        }
        catch (e) {
            debugger;
        }
    }
    function getConfigValues(sections) {
        const root = vscode.workspace.getConfiguration();
        return sections.map(section => {
            return root.get(section);
        });
    }
    return {
        getConfigValues,
        onDependentConfig(sections, fn) {
            const listener = {
                sections,
                fn
            };
            for (const section of sections) {
                const list = watchers.get(section) ?? new Set();
                list.add(listener);
                watchers.set(section, list);
            }
            if (!onDidChangeConfigurationDisposable) {
                setupOnConfigChange();
            }
            return {
                currentValues: getValuesForListener(listener),
                dispose() {
                    for (const section of sections) {
                        const list = watchers.get(section);
                        if (!list) {
                            continue;
                        }
                        list.delete(listener);
                        if (list.size === 0) {
                            watchers.delete(section);
                        }
                        if (watchers.size === 0) {
                            onDidChangeConfigurationDisposable?.dispose();
                            onDidChangeConfigurationDisposable = null;
                        }
                    }
                }
            };
        }
    };
}
//# sourceMappingURL=editor-config.js.map