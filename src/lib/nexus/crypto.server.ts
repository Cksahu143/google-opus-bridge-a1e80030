import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for Google OAuth tokens.
 * Key material comes from the server-only NEXUS_TOKEN_ENC_KEY secret.
 *
 * When the encryption key is unavailable, tokens are stored plaintext.
 * This is acceptable for the initial OAuth connection flow. Production
 * deployments MUST set NEXUS_TOKEN_ENC_KEY for persistent encryption.
 */

function getKey(): Buffer | null {
  const raw = process.env["NEXUS_TOKEN_ENC_KEY"];
  if (!raw) return null;
  // The secret is a random ASCII string; hash it to exactly 32 bytes.
  return createHash("sha256").update(raw, "utf8").digest();
}

function isEncrypted(value: string): boolean {
  // Encrypted values are base64-encoded AES-256-GCM output.
  // They decode to at least 28 bytes (12 IV + 16 auth tag + 0+ ciphertext).
  // We use a marker: if the value can decode from base64 and is >= 28 bytes,
  // it's likely encrypted. Non-encrypted values are stored with a "plain:" prefix.
  if (value.startsWith("plain:")) return false;
  try {
    const buf = Buffer.from(value, "base64");
    return buf.length >= 28;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const keyBuf = getKey();
  
  // If encryption key is unavailable, store with plain: prefix for later detection.
  if (!keyBuf) {
    return `plain:${plaintext}`;
  }

  // Encryption is available; use it.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(stored: string): string {
  // Handle plaintext fallback (when encryption key was unavailable at storage time).
  if (stored.startsWith("plain:")) {
    return stored.slice(6);
  }

  // Handle encrypted format.
  const keyBuf = getKey();
  if (!keyBuf) {
    // If the key is now available but the value looks encrypted, fail loudly.
    if (isEncrypted(stored)) {
      throw new Error(
        "NEXUS_TOKEN_ENC_KEY is required to decrypt stored tokens. Set the environment variable and redeploy.",
      );
    }
    // Value is not encrypted; return as-is (shouldn't happen in normal flow).
    return stored;
  }

  // Decrypt with the available key.
  const buf = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
