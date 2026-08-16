import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { USDC_MINT, type Config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Accepts either the base58 form that Phantom/Solflare export, or the raw
 * 64-byte JSON array that `solana-keygen new --outfile` writes. The JSON form is
 * accepted because the README tells the user to generate a key that way, and
 * silently rejecting their own file is a bad first run.
 */
function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();

  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr) || arr.some((n) => typeof n !== 'number')) {
      throw new Error('WALLET_PRIVATE_KEY looks like JSON but is not a byte array');
    }
    return Uint8Array.from(arr as number[]);
  }

  const decoded = bs58.decode(trimmed);
  return Uint8Array.from(decoded);
}

export class Wallet {
  readonly keypair: Keypair;
  readonly publicKey: PublicKey;
  readonly connection: Connection;
  /** True when no real key was supplied and an ephemeral one was generated for DRY_RUN. */
  readonly ephemeral: boolean;

  private constructor(keypair: Keypair, connection: Connection, ephemeral: boolean) {
    this.keypair = keypair;
    this.publicKey = keypair.publicKey;
    this.connection = connection;
    this.ephemeral = ephemeral;
  }

  static load(cfg: Config): Wallet {
    const connection = new Connection(cfg.solanaRpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60_000,
    });

    if (!cfg.walletPrivateKey) {
      // loadConfig() already guarantees this branch is DRY_RUN only.
      const kp = Keypair.generate();
      logger.warn('WALLET_EPHEMERAL', {
        pubkey: kp.publicKey.toBase58(),
        note: 'No WALLET_PRIVATE_KEY set. Generated a throwaway keypair for DRY_RUN. Balance checks are advisory only.',
      });
      return new Wallet(kp, connection, true);
    }

    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecretKey(parseSecretKey(cfg.walletPrivateKey));
    } catch (err) {
      // Never echo the value, not even a prefix.
      throw new Error(
        `WALLET_PRIVATE_KEY could not be parsed as a Solana secret key (${
          err instanceof Error ? err.message : 'unknown error'
        }). Expected base58 or a 64-byte JSON array.`,
      );
    }

    logger.info('WALLET_LOADED', { pubkey: keypair.publicKey.toBase58() });
    return new Wallet(keypair, connection, false);
  }

  async solBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }

  async usdcBalance(): Promise<number> {
    return this.tokenBalanceUi(USDC_MINT);
  }

  /** Sums every token account the wallet owns for this mint (there is usually exactly one). */
  async tokenBalanceUi(mint: string): Promise<number> {
    const res = await this.connection.getParsedTokenAccountsByOwner(
      this.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    let total = 0;
    for (const { account } of res.value) {
      const parsed = account.data.parsed as
        | { info?: { tokenAmount?: { uiAmount?: number | null } } }
        | undefined;
      total += parsed?.info?.tokenAmount?.uiAmount ?? 0;
    }
    return total;
  }

  /** Raw base-unit balance, which is what Jupiter quotes need. */
  async tokenBalanceRaw(mint: string): Promise<bigint> {
    const res = await this.connection.getParsedTokenAccountsByOwner(
      this.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    let total = 0n;
    for (const { account } of res.value) {
      const parsed = account.data.parsed as
        | { info?: { tokenAmount?: { amount?: string } } }
        | undefined;
      const amount = parsed?.info?.tokenAmount?.amount;
      if (amount) total += BigInt(amount);
    }
    return total;
  }
}
