import { homedir } from "node:os";
import { join } from "node:path";

export function magpieConfigDir(env = process.env) {
  if (env.MAGPIE_CONFIG_DIR) return env.MAGPIE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "magpie");
  return join(homedir(), ".config", "magpie");
}

export function pluginDataDir(env = process.env) {
  return env.MAGPIE_CLEAN_LOGIN_DATA || join(magpieConfigDir(env), "magpie-clean-login");
}
