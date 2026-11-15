import { setPriority } from "node:os";
import { digest } from "@phoenix/store";
import { snapshot } from "./snapshot.ts";

const [root, home, cwd, task, started, copyIgnored] = process.argv.slice(2);
try { setPriority(0, 19); } catch {}
await snapshot({ root: root!, home: home!, cwd: cwd!, task: task!, run: digest(Buffer.from(task!)).slice(7), started: started!, copyIgnored: copyIgnored === "true" });
