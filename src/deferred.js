export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });
    return {
        promise,
        resolve: resolve,
        reject: reject,
    };
}
//# sourceMappingURL=deferred.js.map