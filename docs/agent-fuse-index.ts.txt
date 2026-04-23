import Fuse from "fuse-native";
import { ops } from "./ops/index.js";

export { ops } from "./ops/index.js";

export function mount(mountPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fuse = new Fuse(mountPath, ops, { debug: false });
    fuse.mount(function (err) {
      if (err) {
        console.error("Failed to mount FUSE filesystem:", err);
        reject(err);
      } else {
        console.log("FUSE filesystem mounted successfully.");
        resolve();
      }
    });
  });
}
