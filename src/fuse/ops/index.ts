import type { FuseOps } from "fuse-native";
import { getattr } from "./getattr.js";
import { readdir } from "./readdir.js";
import { open } from "./open.js";
import { read } from "./read.js";
import { write } from "./write.js";
import { release } from "./release.js";
import { truncate, ftruncate } from "./truncate.js";
import { create } from "./create.js";

// `ftruncate` isn't in our minimal FuseOps shim but fuse-native picks it up at
// runtime — attach it via a cast so TypeScript stays happy.
export const ops: FuseOps = {
  init: (cb) => cb(0),
  getattr,
  readdir,
  open,
  read,
  write,
  release,
  truncate,
  create,
};
(ops as Record<string, unknown>).ftruncate = ftruncate;
