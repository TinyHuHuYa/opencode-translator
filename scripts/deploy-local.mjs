// Copy the built plugin into OpenCode's global auto-discovery directory so a
// local (unpublished) install picks up the latest build. Run `npm run
// deploy:local` after changing source. Override the target with
// OPENCODE_PLUGIN_DIR when OpenCode's config lives somewhere non-default.
import { copyFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const source = join(process.cwd(), "dist", "opencode-translator.js")
const target =
  process.env.OPENCODE_PLUGIN_DIR ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
    "plugin",
  )

mkdirSync(target, { recursive: true })
const dest = join(target, "opencode-translator.js")
copyFileSync(source, dest)
console.log(`Deployed ${source} -> ${dest}`)
console.log("Restart OpenCode to load the new build.")
