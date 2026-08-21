import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { credentialsKey } from "@/lib/auth/password";

/**
 * Symmetric encryption for anything stored in the database that must not be
 * readable from the file alone: exchange API secrets, DEX wallet keys, and
 * withdrawal addresses.
 *
 * The key is derived from APP_PASSWORD rather than being its own secret, so there
 * is one value to set and one to rotate. Absent when no password is configured,
 * which makes stored secrets unreadable rather than exposed — and changing the
 * password has the same effect, deliberately: it is the same consequence a
 * rotated master key always had.
 */

const ALGORITHM = "aes-256-gcm";

export function encryptionAvailable(): boolean {
  return credentialsKey() !== null;
}

/** Serialised as iv:tag:ciphertext, all base64. */
export function encryptSecret(plaintext: string): string {
  const key = credentialsKey();
  if (!key) throw new Error("APP_PASSWORD is not set; cannot encrypt");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const key = credentialsKey();
  if (!key) throw new Error("APP_PASSWORD is not set; cannot decrypt");
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Stored secret is malformed");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  // GCM verifies the tag on final(), so tampering throws rather than returning
  // garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
