export function deferred<T>() {
  let resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
  let reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  }
}
