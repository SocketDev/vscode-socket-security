import importFinder from './find-imports.go'

let cachedBin: Promise<string> | null = null
let lastBinPath: string | null = null

export async function generateNativeGoImportBinary (goBin: string) {
    const [
        childProcess,
        path,
        fs,
        os
    ] = await Promise.all([
        import('node:child_process'),
        import('node:path'),
        import('node:fs/promises'),
        import('node:os')
    ])
    if (cachedBin && lastBinPath === goBin) {
        const bin = await cachedBin.catch(() => null)
        if (bin) {
            const valid = await fs.lstat(bin).then(f => {
                return f.isFile()
            }, err => {
                if (err && (typeof err as { code?: unknown }).code === 'ENOENT') {
                    return false
                }
                throw err
            })
            if (valid) return bin
        }
    }
    lastBinPath = goBin
    cachedBin = (async () => {
        const outBin = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'socket-')), 'go-import-parser')
        const build = childProcess.spawn(goBin, ['build', '-o', outBin, importFinder], {
            cwd: __dirname
        })
    
        const exitCode = await new Promise<number | null>((resolve, reject) => {
            build.once('exit', resolve)
            build.once('error', reject)
            setTimeout(() => reject(new Error('timeout')), 3000)
        })
        
        if (exitCode) {
            throw new Error(`failed to build with code ${exitCode}`)
        }

        return outBin
    })()
    
    return cachedBin

}

