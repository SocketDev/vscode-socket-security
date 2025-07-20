declare module '*.wasm' {
    const content: Uint8Array
    export default content
}

declare module '*.go' {
    const filePath: string
    export default filePath
}

declare module '*.py' {
    const fileContents: string
    export default fileContents
}
