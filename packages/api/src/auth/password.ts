import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, { algorithm: Algorithm.Argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plain);
  } catch {
    return false;
  }
}
