import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import inquirer from 'inquirer';
import {
  hasEncrypted,
  decryptToFiles,
  encryptPlaintext,
  hasPlaintext,
} from './config/encrypted-files.js';

/** Print a short summary of what's in accounts.txt without revealing secrets. */
function summarizeAccountsFile(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));

  if (lines.length === 0) {
    console.warn(`\naccounts.txt is empty (or only comments) — fill in your keys/JWTs.`);
    return;
  }

  console.warn(`\naccounts.txt has ${lines.length} entry(ies):`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let kind: string;
    if (line.startsWith('eyJ') && line.split('.').length === 3) {
      kind = `JWT (eyJ...${line.slice(-6)}, ${line.length} chars)`;
    } else if (/^0x?[a-fA-F0-9]{64}$/.test(line) || /^[a-fA-F0-9]{64}$/.test(line)) {
      const hex = line.startsWith('0x') ? line.slice(2) : line;
      kind = `private key (0x${hex.slice(0, 6)}...${hex.slice(-4)})`;
    } else {
      kind = `unrecognized format (starts with "${line.slice(0, 8)}...", ${line.length} chars)`;
    }
    console.warn(`  line ${i + 1}: ${kind}`);
  }
}

function arg(argv: string[], name: string, dflt: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return dflt;
}

async function readPassword(message: string): Promise<string> {
  const { password } = await inquirer.prompt<{ password: string }>([
    { type: 'password', name: 'password', mask: '*', message },
  ]);
  return password;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const cfg = {
    encPath: resolve(arg(argv, '--secrets', 'secrets.enc')),
    accountsPath: resolve(arg(argv, '--accounts', 'accounts.txt')),
    proxiesPath: resolve(arg(argv, '--proxies', 'proxies.txt')),
  };

  if (cmd === 'lock' || cmd === 'encrypt') {
    if (!hasPlaintext(cfg)) {
      console.error('No accounts.txt + proxies.txt to encrypt.');
      process.exit(1);
    }
    const password = await readPassword(
      'Master password (must match existing if secrets.enc exists):',
    );
    if (hasEncrypted(cfg)) {
      // Verify the existing password matches before overwriting
      try {
        const { decryptToMemory } = await import('./config/encrypted-files.js');
        await decryptToMemory(password, cfg);
      } catch {
        console.error('Password does not match existing secrets.enc — refusing to overwrite.');
        process.exit(1);
      }
    } else {
      const confirm = await readPassword('Repeat:');
      if (confirm !== password) {
        console.error('Passwords do not match.');
        process.exit(1);
      }
    }
    const encPath = await encryptPlaintext(password, cfg);
    console.warn(`Encrypted → ${encPath}. Plaintext files removed.`);
    return;
  }

  // default: unlock / decrypt for editing
  if (!hasEncrypted(cfg)) {
    console.error(`No encrypted secrets at ${cfg.encPath}.`);
    console.error('Nothing to decrypt. Run `pnpm play` to set up first.');
    process.exit(1);
  }
  if (existsSync(cfg.accountsPath) || existsSync(cfg.proxiesPath)) {
    console.error('accounts.txt or proxies.txt already exists in the project root.');
    console.error('Either delete them or run `pnpm unlock lock` first to re-encrypt.');
    process.exit(1);
  }

  const password = await readPassword('Master password:');
  try {
    await decryptToFiles(password, cfg);
  } catch {
    console.error('Wrong password (or secrets.enc is corrupted).');
    process.exit(1);
  }

  console.warn(`Decrypted to ${cfg.accountsPath} and ${cfg.proxiesPath}.`);
  summarizeAccountsFile(cfg.accountsPath);
  console.warn('\nEdit them, then run `pnpm play` to re-encrypt and start.');
  console.warn('(Or run `pnpm unlock lock` to re-encrypt without playing.)');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
