import { mount } from "./fuse/index.js";
import { initDb } from "./db/index.js";
import { startRepl } from "./agent.js";

await initDb();
console.log("Database initialized.");

await mount("/workspace");

await startRepl();
