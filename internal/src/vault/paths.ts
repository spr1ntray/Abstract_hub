import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const GIGABOT_HOME = resolve(process.env['GIGABOT_HOME'] ?? join(homedir(), '.gigabot'));
export const VAULT_PATH = join(GIGABOT_HOME, 'vault.enc');
export const STATE_DB_PATH = join(GIGABOT_HOME, 'state.db');
export const LOGS_DIR = join(GIGABOT_HOME, 'logs');
