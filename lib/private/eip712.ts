import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Ethereum signing primitives, for the DEX venues whose authenticated API is a
 * wallet signature rather than an API secret.
 *
 * The CEX venues in lib/private/signing.ts all authenticate with an HMAC over a
 * canonical string, which node:crypto covers. A DEX does not: Hyperliquid, Aster
 * v3 and edgeX all want an EIP-712 typed-data signature, which needs three things
 * Node's crypto does not provide — keccak256 (which is *not* the same permutation
 * as `sha3-256`; the padding byte differs, so Node's `sha3-256` produces a
 * different digest and a signature the venue rejects), recoverable secp256k1
 * signatures carrying a recovery id, and the EIP-712 struct hashing rules.
 *
 * Rather than take a wallet library, this uses @noble/curves and @noble/hashes
 * directly. They are audited, dependency-free, and small enough that what signs a
 * withdrawal is readable in one file. `signing-selftest.ts` checks this module
 * against the vectors published in EIP-712 and EIP-55 before any adapter is
 * allowed to sign, because a subtly wrong digest here is a signature the venue
 * refuses at best and an order for the wrong thing at worst.
 *
 * Nothing here logs, returns or throws a private key.
 */

const HEX = /^(0x)?[0-9a-fA-F]*$/;

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function toHex(data: Uint8Array): string {
  return `0x${Buffer.from(data).toString("hex")}`;
}

export function fromHex(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!HEX.test(trimmed)) throw new Error("not a hex string");
  const body = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (body.length % 2 !== 0) throw new Error("hex string has an odd length");
  return Uint8Array.from(Buffer.from(body, "hex"));
}

function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ─── Keys and addresses ─────────────────────────────────────────────────────

/**
 * Normalises a stored private key. Accepts with or without the 0x prefix, since
 * wallets export it both ways and an operator pasting one form should not get a
 * silent signing failure.
 */
export function normalizePrivateKey(raw: string): Uint8Array {
  const key = fromHex(raw);
  if (key.length !== 32) {
    throw new Error("a wallet private key must be 32 bytes (64 hex characters)");
  }
  // Rejects 0 and anything >= the curve order, which would sign nothing usable.
  if (!secp256k1.utils.isValidSecretKey(key)) {
    throw new Error("not a valid secp256k1 private key");
  }
  return key;
}

/** The lowercase 0x address a private key controls. */
export function addressFromPrivateKey(raw: string): string {
  const key = normalizePrivateKey(raw);
  const pub = secp256k1.getPublicKey(key, false);
  // Drop the 0x04 uncompressed marker; the address is the last 20 bytes of the
  // hash of the 64-byte coordinate pair.
  return `0x${Buffer.from(keccak256(pub.slice(1))).toString("hex").slice(-40)}`;
}

/** EIP-55 mixed-case checksum. Some venues compare addresses as strings. */
export function toChecksumAddress(address: string): string {
  const body = address.trim().replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error("not a 20-byte address");
  const hash = Buffer.from(keccak256(utf8(body))).toString("hex");
  let out = "0x";
  for (let i = 0; i < body.length; i += 1) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/** True when two addresses are the same account, whatever their casing. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ─── Signatures ─────────────────────────────────────────────────────────────

export interface Signature {
  /** 0x-prefixed 32-byte values, as venues expect them in JSON. */
  r: string;
  s: string;
  /** 27 or 28. Ethereum's parity convention, not the raw recovery bit. */
  v: number;
  /** r ‖ s ‖ v as one 65-byte 0x string, for venues that want it flat. */
  serialized: string;
}

/**
 * Signs a 32-byte digest.
 *
 * noble returns the recovery id as the *leading* byte, while Ethereum puts it
 * last and offsets it by 27. Getting that order wrong yields a signature that
 * recovers to a random address, which venues reject with an unhelpful "invalid
 * signature", so the reordering is done here once rather than at each call site.
 *
 * Low-s canonicalisation is noble's default and is required: Ethereum rejects the
 * high-s form of an otherwise valid signature.
 */
export function signDigest(privateKey: string, digest: Uint8Array): Signature {
  if (digest.length !== 32) throw new Error("digest must be 32 bytes");
  const key = normalizePrivateKey(privateKey);
  const raw = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const recovery = raw[0];
  const r = raw.slice(1, 33);
  const s = raw.slice(33, 65);
  const v = recovery + 27;
  return {
    r: toHex(r),
    s: toHex(s),
    v,
    serialized: `0x${Buffer.from(r).toString("hex")}${Buffer.from(s).toString("hex")}${v
      .toString(16)
      .padStart(2, "0")}`,
  };
}

/** EIP-191 personal_sign, for venues that ask for a plain signed message. */
export function signPersonalMessage(privateKey: string, message: string): Signature {
  const body = utf8(message);
  const prefix = utf8(`\u0019Ethereum Signed Message:\n${body.length}`);
  return signDigest(privateKey, keccak256(concat([prefix, body])));
}

// ─── EIP-712 typed data ─────────────────────────────────────────────────────

export interface TypedDataField {
  name: string;
  type: string;
}

export type TypedDataTypes = Record<string, TypedDataField[]>;

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number | bigint;
  verifyingContract?: string;
  salt?: string;
}

/** Field order is fixed by the spec; only present members are encoded. */
const DOMAIN_FIELDS: TypedDataField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

function domainType(domain: TypedDataDomain): TypedDataField[] {
  return DOMAIN_FIELDS.filter(
    (field) => domain[field.name as keyof TypedDataDomain] !== undefined,
  );
}

/** Struct dependencies, alphabetically after the primary type, as the spec says. */
function dependencies(types: TypedDataTypes, primaryType: string, found = new Set<string>()): string[] {
  const base = primaryType.replace(/\[.*$/, "");
  if (found.has(base) || types[base] === undefined) return [...found];
  found.add(base);
  for (const field of types[base]) dependencies(types, field.type, found);
  return [...found];
}

function encodeType(types: TypedDataTypes, primaryType: string): string {
  const [first, ...rest] = dependencies(types, primaryType);
  const ordered = [first, ...rest.sort()];
  return ordered
    .map((name) => `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(",")})`)
    .join("");
}

function typeHash(types: TypedDataTypes, primaryType: string): Uint8Array {
  return keccak256(utf8(encodeType(types, primaryType)));
}

function padLeft32(data: Uint8Array): Uint8Array {
  if (data.length > 32) throw new Error("value does not fit in 32 bytes");
  const out = new Uint8Array(32);
  out.set(data, 32 - data.length);
  return out;
}

/** 2^256, for two's complement. Built rather than written as a literal because the
 * project targets ES2017, where BigInt literal syntax is not available. */
const TWO_256 = BigInt(2) ** BigInt(256);
const ZERO = BigInt(0);

function encodeNumber(type: string, value: unknown): Uint8Array {
  const asBigInt =
    typeof value === "bigint"
      ? value
      : typeof value === "number"
        ? BigInt(Math.trunc(value))
        : BigInt(String(value).trim());
  const signed = type.startsWith("int");
  if (!signed && asBigInt < ZERO) throw new Error(`${type} cannot be negative`);
  // Two's complement for the signed case, which is what abi encoding stores.
  const normalized = asBigInt < ZERO ? TWO_256 + asBigInt : asBigInt;
  const hex = normalized.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error(`value overflows ${type}`);
  return fromHex(hex);
}

function encodeValue(
  types: TypedDataTypes,
  type: string,
  value: unknown,
): Uint8Array {
  if (type.endsWith("]")) {
    const inner = type.slice(0, type.lastIndexOf("["));
    if (!Array.isArray(value)) throw new Error(`${type} expects an array`);
    return keccak256(concat(value.map((item) => encodeValue(types, inner, item))));
  }
  if (types[type] !== undefined) {
    return hashStruct(types, type, value as Record<string, unknown>);
  }
  if (type === "string") {
    return keccak256(utf8(String(value)));
  }
  if (type === "bytes") {
    return keccak256(fromHex(String(value)));
  }
  if (type === "bool") {
    const out = new Uint8Array(32);
    out[31] = value ? 1 : 0;
    return out;
  }
  if (type === "address") {
    const bytes = fromHex(String(value));
    if (bytes.length !== 20) throw new Error("address must be 20 bytes");
    return padLeft32(bytes);
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type)) {
    const width = Number(type.slice(5));
    const bytes = fromHex(String(value));
    if (bytes.length !== width) throw new Error(`${type} expects ${width} bytes`);
    // Fixed bytes are right-padded, unlike numbers.
    const out = new Uint8Array(32);
    out.set(bytes, 0);
    return out;
  }
  if (/^u?int\d*$/.test(type)) {
    return encodeNumber(type, value);
  }
  throw new Error(`unsupported EIP-712 type: ${type}`);
}

export function hashStruct(
  types: TypedDataTypes,
  primaryType: string,
  data: Record<string, unknown>,
): Uint8Array {
  const fields = types[primaryType];
  if (!fields) throw new Error(`unknown struct type: ${primaryType}`);
  const parts: Uint8Array[] = [typeHash(types, primaryType)];
  for (const field of fields) {
    const value = data[field.name];
    if (value === undefined) throw new Error(`missing field ${primaryType}.${field.name}`);
    parts.push(encodeValue(types, field.type, value));
  }
  return keccak256(concat(parts));
}

export function hashDomain(domain: TypedDataDomain): Uint8Array {
  const fields = domainType(domain);
  const data: Record<string, unknown> = {};
  for (const field of fields) data[field.name] = domain[field.name as keyof TypedDataDomain];
  return hashStruct({ EIP712Domain: fields }, "EIP712Domain", data);
}

/** The 32-byte digest an EIP-712 signature is taken over. */
export function hashTypedData(
  domain: TypedDataDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: Record<string, unknown>,
): Uint8Array {
  return keccak256(
    concat([
      Uint8Array.from([0x19, 0x01]),
      hashDomain(domain),
      hashStruct(types, primaryType, message),
    ]),
  );
}

export function signTypedData(
  privateKey: string,
  domain: TypedDataDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: Record<string, unknown>,
): Signature {
  return signDigest(privateKey, hashTypedData(domain, types, primaryType, message));
}
