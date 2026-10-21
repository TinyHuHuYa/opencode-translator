// Copy the built Pi extension into Pi's user extensions directory so Pi and
// desktop clients that launch it (for example Pi Desktop) pick it up. Run
// `npm run deploy:pi` after changing source. Override the target with
// PI_EXTENSIONS_DIR, or relocate Pi's agent directory with PI_CODING_AGENT_DIR.
import { copyFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const source = join(process.cwd(), "dist", "pi-translator.js")
const target =
  process.env.PI_EXTENSIONS_DIR ??
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "extensions")

mkdirSync(target, { recursive: true })
const dest = join(target, "pi-translator.js")
copyFileSync(source, dest)
console.log(`Deployed ${source} -> ${dest}`)
console.log("Start a new Pi session (or run /reload) to load the new build.")
