import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Generates a dedicated trading keypair on the machine that will use it.
 *
 * This exists so the Solana CLI is not a hard dependency — `release.solana.com`
 * and `release.anza.xyz` are both unreachable from some egress paths, including
 * the VPN this bot runs behind.
 *
 * It also avoids the worse habit the CLI encourages: generating a key, `cat`-ing
 * it, and pasting the secret through a terminal and a chat window to get it into
 * .env. The secret is written straight to a mode-600 file and this program never
 * prints it. Only the public key reaches stdout.
 */

function die(msg: string): never {
  process.stderr.write(`\n${msg}\n\n`);
  process.exit(1);
}

const outPath = process.argv[2] ?? '/opt/solana-sniper/data/wallet.json';
const resolved = path.resolve(outPath);

if (fs.existsSync(resolved)) {
  die(
    `Refusing to overwrite an existing keypair at ${resolved}\n` +
      'If you genuinely want a new wallet, move the old file aside first —\n' +
      'overwriting it destroys access to whatever that wallet holds.',
  );
}

const kp = Keypair.generate();
const secretArray = Array.from(kp.secretKey);

fs.mkdirSync(path.dirname(resolved), { recursive: true });
// Create with 0600 from the outset rather than chmod-ing after; a world-readable
// window, however brief, is a world-readable private key.
fs.writeFileSync(resolved, JSON.stringify(secretArray), { mode: 0o600 });
fs.chmodSync(resolved, 0o600);

const base58Secret = bs58.encode(kp.secretKey);
const envPath = path.join(path.dirname(resolved), 'wallet.env');
fs.writeFileSync(envPath, `WALLET_PRIVATE_KEY=${base58Secret}\n`, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);

process.stdout.write(
  [
    '',
    'Generated a new Solana keypair.',
    '',
    `  Public key : ${kp.publicKey.toBase58()}`,
    `  Secret     : ${resolved} (mode 600, JSON byte array)`,
    `  For .env   : ${envPath} (mode 600, base58)`,
    '',
    'The secret key was NOT printed and must not be. To load it into .env without',
    'it ever touching your screen, scrollback or clipboard:',
    '',
    `  grep -v '^WALLET_PRIVATE_KEY=' /opt/solana-sniper/.env > /tmp/.env.new`,
    `  cat ${envPath} >> /tmp/.env.new`,
    '  mv /tmp/.env.new /opt/solana-sniper/.env',
    '  chmod 600 /opt/solana-sniper/.env',
    '  chown sniper:sniper /opt/solana-sniper/.env',
    '',
    'Fund the PUBLIC key above with USDC and at least 0.1 SOL.',
    'Back up the secret file somewhere safe and offline. If you lose it, you lose',
    'whatever the wallet holds — there is no recovery path.',
    '',
  ].join('\n'),
);
