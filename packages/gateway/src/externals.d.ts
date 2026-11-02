declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream'

  export interface PeerInfo {
    publicKey?: Uint8Array
    topics?: Uint8Array[]
    forceRelaying?: boolean
    relayAddresses?: unknown[]
  }

  export interface PeerDiscovery {
    flushed(): Promise<void>
    destroy(): Promise<void>
  }

  export default class Hyperswarm {
    constructor(options?: Record<string, unknown>)
    on(event: 'connection', listener: (socket: Duplex, info: PeerInfo) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    join(topic: Uint8Array, options?: Record<string, unknown>): PeerDiscovery
    flush(): Promise<void>
    destroy(options?: Record<string, unknown>): Promise<void>
  }
}

declare module 'corestore' {
  import type { Duplex } from 'node:stream'

  export default class Corestore {
    constructor(storage: string, options?: Record<string, unknown>)
    ready(): Promise<void>
    replicate(stream: Duplex, options?: Record<string, unknown>): unknown
    close(): Promise<void>
  }
}

declare module 'hyperdrive' {
  export default class Hyperdrive {
    constructor(store: unknown, key?: Uint8Array)
    ready(): Promise<void>
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly core: { readonly length: number }
    get(path: string, options?: Record<string, unknown>): Promise<Buffer | null>
    update(options?: Record<string, unknown>): Promise<boolean>
    put(path: string, buffer: Uint8Array, options?: Record<string, unknown>): Promise<void>
    entry(path: string, options?: Record<string, unknown>): Promise<unknown | null>
    close(): Promise<void>
  }
}
