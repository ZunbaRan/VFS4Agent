/**
 * Minimal type shim for `fuse-native`. The package ships no official .d.ts.
 * We declare the surface we actually use; the rest is `any`.
 */
declare module "fuse-native" {
  type Cb<T = void> = (err: number, result?: T) => void;

  export interface FuseOps {
    init?: (cb: (err: number) => void) => void;
    getattr?: (path: string, cb: Cb<any>) => void;
    readdir?: (path: string, cb: Cb<string[]>) => void;
    open?: (path: string, flags: number, cb: Cb<number>) => void;
    read?: (
      path: string,
      fd: number,
      buf: Buffer,
      len: number,
      pos: number,
      cb: (bytesRead: number) => void,
    ) => void;
    write?: (
      path: string,
      fd: number,
      buf: Buffer,
      len: number,
      pos: number,
      cb: (bytesWritten: number) => void,
    ) => void;
    release?: (path: string, fd: number, cb: (err: number) => void) => void;
    truncate?: (path: string, size: number, cb: (err: number) => void) => void;
    create?: (path: string, mode: number, cb: Cb<number>) => void;
    unlink?: (path: string, cb: (err: number) => void) => void;
  }

  export interface FuseOpts {
    debug?: boolean;
    force?: boolean;
    mkdir?: boolean;
    allowOther?: boolean;
    autoUnmount?: boolean;
    displayFolder?: boolean;
    [k: string]: unknown;
  }

  export default class Fuse {
    constructor(mnt: string, ops: FuseOps, opts?: FuseOpts);
    mount(cb: (err: Error | null) => void): void;
    unmount(cb: (err: Error | null) => void): void;
    static unmount(mnt: string, cb: (err: Error | null) => void): void;

    static readonly ENOENT: number;
    static readonly EBADF: number;
    static readonly EROFS: number;
    static readonly EACCES: number;
    static readonly EIO: number;
    static readonly ENOTDIR: number;
    static readonly EEXIST: number;
    static readonly EPERM: number;
    static readonly ENOTSUP: number;
  }
}
