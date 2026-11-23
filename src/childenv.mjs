/**
 * childenv.mjs - the environment a program started for a bot gets (SEC-12).
 *
 * The hub runs with its own secrets in the environment (ASSIST_PROXY_SECRET,
 * DESK_VNC_PASSWORD, a model key...) and the user may have more (GITHUB_TOKEN,
 * DB_PASSWORD). A command a bot runs, a coding assistant, or a connected app
 * gets none of them: the hub's own ASSIST_* / DESK_* settings and anything
 * named like a key, token, secret or password are taken out. PATH, HOME, LANG
 * and the rest stay, so programs still find what they need.
 *
 * `keep` puts back named variables a program needs to sign in (a coding
 * assistant that uses OPENAI_API_KEY instead of a subscription login).
 */

const HUB_OWN = /^(ASSIST_|DESK_)/i;
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i;

export function childEnv(source = process.env, { keep = [] } = {}) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (HUB_OWN.test(key) || SECRET_NAME.test(key)) delete env[key];
  }
  for (const key of keep) {
    if (!HUB_OWN.test(key) && source[key] !== undefined) env[key] = source[key];
  }
  return dropPwshModulePath(env);
}

/**
 * PSModulePath as PowerShell 7 leaves it (1.5.63). A hub started from a pwsh window inherits
 * PowerShell 7's module folders ("...\PowerShell\7\Modules", "Documents\PowerShell\Modules");
 * Windows PowerShell 5.1 started with them cannot load its own modules ("ConvertTo-SecureString
 * ... the module could not be loaded"). Taken out, each PowerShell builds its own default again.
 * Windows PowerShell's own value (WindowsPowerShell folders only) is left as it is. Changes env.
 */
export const PWSH7_MODULES = /\\PowerShell\\(?:7[^\\;]*\\)?Modules/i;
export function dropPwshModulePath(env = process.env) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath' && PWSH7_MODULES.test(String(env[key] || ''))) delete env[key];
  }
  return env;
}
