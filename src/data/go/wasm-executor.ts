// TODO: add to @socket/utils
import { randomBytes } from 'crypto'

interface GoSyscallError extends Error {
  code: string
}

const enosys = () => {
  const err = new Error('not implemented') as GoSyscallError
  err.code = 'ENOSYS'
  if ('captureStackTrace' in Error) {
    Error.captureStackTrace(err, enosys)
  }
  return err
}

type GoCallback<T = unknown> = {
  (err: Error): void
  (err: null, result: T): void
}

type GoInstance = WebAssembly.Instance & {
  exports: {
    mem: WebAssembly.Memory
    getsp(): number
    run(argc: number, argv: number): void
    resume(): void
  }
}

interface GoPendingEvent {
  id: number
  this: unknown
  args: IArguments
  result?: unknown
}

const textEnc = new TextEncoder()
const textDec = new TextDecoder()

class GoExecutor<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly goImportObject: WebAssembly.ModuleImports
  readonly argv: string[]
  readonly env: Map<string, string>
  readonly exports: T
  private consumed = false
  private exitPromise: Promise<void>
  private onExit!: () => void
  private exitCode: number | undefined
  private instance: GoInstance | undefined
  private mem: DataView | undefined
  _pendingEvent: GoPendingEvent | null

  constructor () {
    this._pendingEvent = null
    this.exitPromise = new Promise(resolve => {
      this.onExit = resolve
    })
    this.argv = ['js']
    this.env = new Map()
    this.exports = Object.create(null)

    const goGlobal: unknown = {
      fs: {
        constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
        write (_fd: number, _buf: BufferSource, _offset: number, _length: number, _position: number, callback: GoCallback) {
          callback(enosys())
        },
        chmod (_path: string, _mode: number, callback: GoCallback) { callback(enosys()) },
        chown (_path: string, _uid: number, _gid: number, callback: GoCallback) { callback(enosys()) },
        close (_fd: number, callback: GoCallback) { callback(enosys()) },
        fchmod (_fd: number, _mode: number, callback: GoCallback) { callback(enosys()) },
        fchown (_fd: number, _uid: number, _gid: number, callback: GoCallback) { callback(enosys()) },
        fstat (_fd: number, callback: GoCallback) { callback(enosys()) },
        fsync (_fd: number, callback: GoCallback<void>) { callback(null) },
        ftruncate (_fd: number, _length: number, callback: GoCallback) { callback(enosys()) },
        lchown (_path: string, _uid: number, _gid: number, callback: GoCallback) { callback(enosys()) },
        link (_path: string, _link: string, callback: GoCallback) { callback(enosys()) },
        lstat (_path: string, callback: GoCallback) { callback(enosys()) },
        mkdir (_path: string, _perm: number, callback: GoCallback) { callback(enosys()) },
        open (_path: string, _flags: number, _mode: number, callback: GoCallback) { callback(enosys()) },
        read (_fd: number, _buf: ArrayBuffer | ArrayBufferView, _offset: number, _length: number, _position: number, callback: GoCallback) {
          callback(enosys())
        },
        readdir (_path: string, callback: GoCallback) { callback(enosys()) },
        readlink (_path: string, callback: GoCallback) { callback(enosys()) },
        rename (_from: string, _to: string, callback: GoCallback) { callback(enosys()) },
        rmdir (_path: string, callback: GoCallback) { callback(enosys()) },
        stat (_path: string, callback: GoCallback) { callback(enosys()) },
        symlink (_path: string, _link: string, callback: GoCallback) { callback(enosys()) },
        truncate (_path: string, _length: number, callback: GoCallback) { callback(enosys()) },
        unlink (_path: string, callback: GoCallback) { callback(enosys()) },
        utimes (_path: string, _atime: number, _mtime: number, callback: GoCallback) { callback(enosys()) },
      },
      process: {
        getuid () { return -1 },
        getgid () { return -1 },
        geteuid () { return -1 },
        getegid () { return -1 },
        getgroups () { throw enosys() },
        pid: -1,
        ppid: -1,
        umask () { throw enosys() },
        cwd () { throw enosys() },
        chdir () { throw enosys() },
      }
    }

    let goValues: Map<number, unknown> | undefined = new Map([
      [0, NaN],
      [1, 0],
      [2, null],
      [3, true],
      [4, false],
      [5, goGlobal],
      [6, this]
    ])
    let goKeys: Map<unknown, number> | undefined = new Map()
    const goRefCount: Record<number, number> | undefined = {}
    for (const [key, value] of goValues) {
      goKeys.set(value, key)
      goRefCount[key] = 2 ** 32
    }
    const timeBasis = Date.now() - performance.now()
    let timeoutID = 0
    const timeouts: Map<number, ReturnType<typeof setTimeout>> = new Map()

    const loadValue = (addr: number) => {
      const f = this.mem!.getFloat64(addr, true)
      if (f === 0) return undefined
      if (!isNaN(f)) return f

      const id = this.mem!.getUint32(addr, true)
      return goValues!.get(id)
    }

    const storeValue = (addr: number, v: unknown) => {
      const nanHead = 0x7FF80000

      if (typeof v === 'number' && v !== 0) {
        if (isNaN(v)) {
          // force empty NaN representation
          this.mem!.setUint32(addr + 4, nanHead, true)
          this.mem!.setUint32(addr, 0, true)
        } else {
          this.mem!.setFloat64(addr, v, true)
        }
        return
      }

      if (v === undefined) {
        this.mem!.setFloat64(addr, 0, true)
        return
      }

      let id = goKeys!.get(v)
      if (id === undefined) {
        do {
          id = Math.floor(Math.random() * 2 ** 32)
        } while (goValues!.has(id))
        goValues!.set(id, v)
        goKeys!.set(v, id)
        goRefCount![id] = 0
      }
      ++goRefCount![id]

      let typeFlag = 0
      switch (typeof v) {
        case 'object':
          if (v !== null) {
            typeFlag = 1
          }
          break
        case 'string':
          typeFlag = 2
          break
        case 'symbol':
          typeFlag = 3
          break
        case 'function':
          typeFlag = 4
          break
      }
      this.mem!.setUint32(addr + 4, nanHead | typeFlag, true)
      this.mem!.setUint32(addr, id, true)
    }

    const loadSlice = (addr: number) => {
      const offset = Number(this.mem!.getBigInt64(addr + 0, true))
      const len = Number(this.mem!.getBigInt64(addr + 8, true))
      return new Uint8Array(
        this.instance!.exports.mem.buffer,
        offset,
        len
      )
    }

    const loadSliceOfValues = (addr: number) => {
      const offset = Number(this.mem!.getBigInt64(addr + 0, true))
      const len = Number(this.mem!.getBigInt64(addr + 8, true))
      const a: unknown[] = []
      for (let i = 0; i < len; i++) {
        a.push(loadValue(offset + i * 8))
      }
      return a
    }

    const loadString = (addr: number) => {
      const saddr = Number(this.mem!.getBigInt64(addr + 0, true))
      const len = Number(this.mem!.getBigInt64(addr + 8, true))
      return textDec.decode(
        new DataView(
          this.instance!.exports.mem.buffer,
          saddr,
          len
        )
      )
    }

    this.goImportObject = {
      'runtime.wasmExit': (sp: number) => {
        sp >>>= 0
        this.exitCode = this.mem!.getInt32(sp + 8, true)
        this.instance = undefined
        goValues = undefined
        goKeys = undefined
      },
      'runtime.wasmWrite': () => {
        // noop (write to file descriptor)
      },
      'runtime.resetMemoryDataView': () => {
        // called on memory.grow instruction
        this.mem = new DataView(this.instance!.exports.mem.buffer)
      },
      'runtime.nanotime1': (sp: number) => {
        sp >>>= 0
        this.mem!.setBigInt64(sp + 8, BigInt(Math.round((timeBasis + performance.now()) * 1000000)), true)
      },
      'runtime.walltime': (sp: number) => {
        sp >>>= 0
        const msec = Date.now()
        this.mem!.setBigInt64(sp + 8, BigInt(Math.floor(msec / 1000)), true)
        this.mem!.setInt32(sp + 16, (msec % 1000) * 1000000, true)
      },
      'runtime.scheduleTimeoutEvent': (sp: number) => {
        sp >>>= 0
        const curID = timeoutID++
        timeouts.set(curID, setTimeout(
          () => {
            // wait for timeout to be deregistered
            while (timeouts.has(curID)) this.resume()
          },
          // setTimeout inexact: fire 1 millisecond later
          Number(this.mem!.getBigInt64(sp + 8, true)) + 1
        ))
        this.mem!.setInt32(sp + 16, curID, true)
      },
      'runtime.clearTimeoutEvent': (sp: number) => {
        sp >>>= 0
        const id = this.mem!.getInt32(sp + 8, true)
        clearTimeout(timeouts.get(id))
        timeouts.delete(id)
      },
      'runtime.getRandomData': (sp: number) => {
        sp >>>= 0
        const slice = loadSlice(sp + 8)
        slice.set(randomBytes(slice.byteLength))
      },
      'syscall/js.finalizeRef': (sp: number) => {
        sp >>>= 0
        const id = this.mem!.getUint32(sp + 8, true)
        if (!--goRefCount![id]) {
          const v = goValues!.get(id)
          goValues!.delete(id)
          goKeys!.delete(v)
          delete goRefCount![id]
        }
      },
      'syscall/js.stringVal': (sp: number) => {
        sp >>>= 0
        storeValue(sp + 24, loadString(sp + 8))
      },
      'syscall/js.valueGet': (sp: number) => {
        sp >>>= 0
        const obj = loadValue(sp + 8) as Record<string, unknown>
        const key = loadString(sp + 16)
        let result = obj[key]
        if (obj === goGlobal && !(key in obj)) {
          result = this.exports[key as keyof T]
          if (!(key in this.exports)) {
            result = globalThis[key as keyof typeof globalThis]
          }
        }
        sp = this.instance!.exports.getsp() >>> 0
        storeValue(sp + 32, result)
      },
      'syscall/js.valueSet': (sp: number) => {
        sp >>>= 0
        let obj = loadValue(sp + 8) as Record<string, unknown>
        const key = loadString(sp + 16)
        if (obj === goGlobal && !(key in goGlobal)) {
          obj = this.exports
        }
        obj[key] = loadValue(sp + 32)
      },
      'syscall/js.valueDelete': (sp: number) => {
        sp >>>= 0
        delete (loadValue(sp + 8) as Record<string, unknown>)[loadString(sp + 16)]
      },
      'syscall/js.valueIndex': (sp: number) => {
        sp >>>= 0
        storeValue(sp + 24, (loadValue(sp + 8) as unknown[])[
          Number(this.mem!.getBigInt64(sp + 16, true))
        ])
      },
      'syscall/js.valueSetIndex': (sp: number) => {
        sp >>>= 0
        ;(loadValue(sp + 8) as unknown[])[
          Number(this.mem!.getBigInt64(sp + 16, true))
        ] = loadValue(sp + 24)
      },
      'syscall/js.valueCall': (sp: number) => {
        sp >>>= 0
        try {
          const v = loadValue(sp + 8) as Record<string, unknown>
          const m = v[loadString(sp + 16)] as Function
          const args = loadSliceOfValues(sp + 32)
          const result = m.apply(v, args)
          sp = this.instance!.exports.getsp() >>> 0
          storeValue(sp + 56, result)
          this.mem!.setUint8(sp + 64, 1)
        } catch (err) {
          sp = this.instance!.exports.getsp() >>> 0
          storeValue(sp + 56, err)
          this.mem!.setUint8(sp + 64, 0)
        }
      },
      'syscall/js.valueInvoke': (sp: number) => {
        sp >>>= 0
        try {
          const v = loadValue(sp + 8) as Function
          const args = loadSliceOfValues(sp + 16)
          const result = v.apply(undefined, args)
          sp = this.instance!.exports.getsp() >>> 0
          storeValue(sp + 40, result)
          this.mem!.setUint8(sp + 48, 1)
        } catch (err) {
          sp = this.instance!.exports.getsp() >>> 0
          storeValue(sp + 40, err)
          this.mem!.setUint8(sp + 48, 0)
        }
      },
      'syscall/js.valueNew': (sp: number) => {
        sp >>>= 0
        try {
          const Ctor = loadValue(sp + 8) as new (...args: unknown[]) => unknown
          const args = loadSliceOfValues(sp + 16)
          const result = new Ctor(...args)
          sp = this.instance!.exports.getsp() >>> 0
          storeValue(sp + 40, result)
          this.mem!.setUint8(sp + 48, 1)
        } catch (err) {
          sp = this.instance!.exports.getsp() >>> 0
          storeValue(sp + 40, err)
          this.mem!.setUint8(sp + 48, 0)
        }
      },
      'syscall/js.valueLength': (sp: number) => {
        sp >>>= 0
        this.mem!.setBigInt64(
          sp + 16,
          BigInt((loadValue(sp + 8) as { length: number | string }).length),
          true
        )
      },
      'syscall/js.valuePrepareString': (sp: number) => {
        sp >>>= 0
        const str = textEnc.encode(String(loadValue(sp + 8)))
        storeValue(sp + 16, str)
        this.mem!.setBigInt64(sp + 24, BigInt(str.length), true)
      },
      'syscall/js.valueLoadString': (sp: number) => {
        sp >>>= 0
        const str = loadValue(sp + 8) as Uint8Array
        loadSlice(sp + 16).set(str)
      },
      'syscall/js.valueInstanceOf': (sp: number) => {
        sp >>>= 0
        this.mem!.setUint8(
          sp + 24,
          +(loadValue(sp + 8) instanceof (loadValue(sp + 16) as Function))
        )
      },
      'syscall/js.copyBytesToGo': (sp: number) => {
        sp >>>= 0
        const dst = loadSlice(sp + 8)
        const src = loadValue(sp + 32)
        if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
          this.mem!.setUint8(sp + 48, 0)
          return
        }
        const toCopy = src.subarray(0, dst.length)
        dst.set(toCopy)
        this.mem!.setBigInt64(sp + 40, BigInt(toCopy.length))
        this.mem!.setUint8(sp + 48, 1)
      },
      'syscall/js.copyBytesToJS': (sp: number) => {
        sp >>>= 0
        const dst = loadValue(sp + 8)
        const src = loadSlice(sp + 16)
        if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
          this.mem!.setUint8(sp + 48, 0)
          return
        }
        const toCopy = src.subarray(0, dst.length)
        dst.set(toCopy)
        this.mem!.setBigInt64(sp + 40, BigInt(toCopy.length))
        this.mem!.setUint8(sp + 48, 1)
      },
      debug: (value: unknown) => {
        console.log(value)
      }
    }
  }

  async run (instance: WebAssembly.Instance) {
    if (this.consumed) {
      throw new Error('cannot execute multiple times')
    }
    this.consumed = true
    this.instance = instance as GoInstance
    this.mem = new DataView(this.instance.exports.mem.buffer)
    let offset = 4096

    const strPtr = (str: string) => {
      const ptr = offset
      const bytes = textEnc.encode(str + '\0')
      new Uint8Array(this.mem!.buffer, offset, bytes.length).set(bytes)
      offset += bytes.length
      if (offset & 7) {
        offset += 8 - (offset & 7)
      }
      return ptr
    }

    const argc = this.argv.length

    const argvPtrs = [
      ...this.argv.map(strPtr),
      0,
      ...[...this.env.keys()].sort().map(
        key => strPtr(`${key}=${this.env.get(key)}`)
      ),
      0
    ]

    const argv = offset
    argvPtrs.forEach(ptr => {
      this.mem!.setUint32(offset, ptr, true)
      this.mem!.setUint32(offset + 4, 0, true)
      offset += 8
    })

    const wasmMinDataAddr = 4096 + 8192
    if (offset >= wasmMinDataAddr) {
      throw new Error('argv too long')
    }

    this.instance!.exports.run(argc, argv)
    if (this.exitCode !== undefined) {
      this.onExit()
    }
    await this.exitPromise
    return this.exitCode
  }

  private resume () {
    if (this.exitCode !== undefined) {
      throw new Error('Go program has already exited')
    }
    this.instance!.exports.resume()
    if (this.exitCode !== undefined) {
      this.onExit()
    }
  }

  // Called by Go WASM code
  _makeFuncWrapper (id: number) {
    const go = this
    return function (this: unknown) {
      const event: GoPendingEvent = { id, this: this, args: arguments }
      go._pendingEvent = event
      go.resume()
      return event.result
    }
  }
}

export default GoExecutor
