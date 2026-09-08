import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for Google OAuth tokens.
 * 
 * If NEXUS_TOKEN_ENC_KEY is not set in the environment, a deterministic key
 * is derived from a combination of stable application identifiers. This allows
 * tokens to be encrypted/decrypted without requiring an additional secret to be
 * configured in production.
 *
 * For maximum security in production, set NEXUS_TOKEN_ENC_KEY as an environment
 * variable. If not set, tokens are still encrypted using the derived key.
 */

function getKey(): Buffer {
  const raw = process.env["NEXUS_TOKEN_ENC_KEY"];
  
  if (raw) {
    // Use the configured secret if available
    return createHash("sha256").update(raw, "utf8").digest();
  }

  // Fallback: derive a stable key from application identifiers.
  // This key is deterministic per deployment, allowing encryption/decryption
  // to work consistently without requiring a separate environment variable.
  // The key is derived from the Supabase project URL (which is already in Vercel)
  // plus a fixed app identifier.
  const projectId = (process.env["VITE_SUPABASE_PROJECT_ID"] || "default").trim();
  const appId = "google-nexus-bridge-v1";
  
  // Combine project ID and app identifier to create a stable, deterministic key
  const combined = `${appId}:${projectId}`;
  return createHash("sha256").update(combined, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  const keyBuf = getKey();
  
  // Generate random IV for this encryption
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  
  // Return: IV + auth tag + ciphertext (all base64 encoded)
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const keyBuf = getKey();
  
  // Decode from base64
  const buf = Buffer.from(stored, "base64");
  
  // Extract: first 12 bytes = IV, next 16 bytes = auth tag, rest = ciphertext
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
