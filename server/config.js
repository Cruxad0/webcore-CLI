import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, chmod } from 'node:fs/promises';

export const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'webcore-toolkit');
export const configPath = join(configDir, 'config.json');
export async function loadConfig() {
  try { return JSON.parse(await readFile(configPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Could not read local configuration: ${e.message}`); }
}
export async function saveConfig(config) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  const tmp = `${configPath}.${process.pid}.tmp`;
  await import('node:fs/promises').then(({ writeFile }) => writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }));
  await chmod(tmp, 0o600);
  await rename(tmp, configPath);
  await chmod(configPath, 0o600);
}
export async function removeConfig() {
  const { unlink } = await import('node:fs/promises');
  try { await unlink(configPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
