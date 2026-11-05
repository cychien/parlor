import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A spec that runs the daemon registers the app with the coding agents it finds, under HOME.
const home = mkdtempSync(join(tmpdir(), "parlor-host-home-"));
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
