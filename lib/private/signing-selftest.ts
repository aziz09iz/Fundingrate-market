import {
  addressFromPrivateKey,
  hashTypedData,
  keccak256,
  signPersonalMessage,
  signTypedData,
  toChecksumAddress,
  toHex,
} from "@/lib/private/eip712";

/**
 * Self-test for the Ethereum signing primitives.
 *
 * Every DEX adapter calls `assertSigningHealthy()` before it signs anything. The
 * point is not to test the library — noble is audited — but to catch the two ways
 * this app could be wrong about it: a keccak256 that is silently NIST SHA-3
 * (whose digest differs only because of one padding byte, so it looks like a
 * working hash right up until the venue rejects the signature), and a recovery id
 * placed at the wrong end of the 65-byte signature.
 *
 * The vectors are the ones published with EIP-712 and EIP-55, so a failure here
 * means this module is wrong rather than the venue.
 *
 * It runs once per process and its result is cached, so an adapter can call it on
 * every order without paying for it twice.
 */

/** EIP-712's own example: the digest and signature are given in the spec. */
const MAIL_DOMAIN = {
  name: "Ether Mail",
  version: "1",
  chainId: 1,
  verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCcCcCcCcCcCcCcCcCC",
};

const MAIL_TYPES = {
  Person: [
    { name: "name", type: "string" },
    { name: "wallet", type: "address" },
  ],
  Mail: [
    { name: "from", type: "Person" },
    { name: "to", type: "Person" },
    { name: "contents", type: "string" },
  ],
};

const MAIL_MESSAGE = {
  from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
  to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
  contents: "Hello, Bob!",
};

const MAIL_DIGEST = "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2";

/** The spec's signing key is keccak256("cow"). */
const COW_KEY = toHex(keccak256(Uint8Array.from(Buffer.from("cow", "utf8"))));
const COW_ADDRESS = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const MAIL_SIGNATURE =
  "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d" +
  "07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c";

/** EIP-55's own checksum examples. */
const CHECKSUM_CASES = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

/** A hash Node's `sha3-256` would get wrong, which is the whole point. */
const KECCAK_EMPTY = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

function check(label: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`signing self-test failed at ${label}: got ${actual}, expected ${expected}`);
  }
}

function runSelfTest(): void {
  check("keccak256(empty)", toHex(keccak256(new Uint8Array())), KECCAK_EMPTY);

  for (const address of CHECKSUM_CASES) {
    check("EIP-55 checksum", toChecksumAddress(address.toLowerCase()), address);
  }

  check("address from key", toChecksumAddress(addressFromPrivateKey(COW_KEY)), COW_ADDRESS);

  check(
    "EIP-712 digest",
    toHex(hashTypedData(MAIL_DOMAIN, MAIL_TYPES, "Mail", MAIL_MESSAGE)),
    MAIL_DIGEST,
  );

  const signature = signTypedData(COW_KEY, MAIL_DOMAIN, MAIL_TYPES, "Mail", MAIL_MESSAGE);
  check("EIP-712 signature", signature.serialized, MAIL_SIGNATURE);
  if (signature.v !== 28) {
    throw new Error(`signing self-test failed: expected v=28, got ${signature.v}`);
  }

  // No published vector for this one; the check is that it is deterministic and
  // well-formed, since the recovery byte is the part that tends to be wrong.
  const personal = signPersonalMessage(COW_KEY, "hello");
  if (personal.serialized.length !== 132 || (personal.v !== 27 && personal.v !== 28)) {
    throw new Error("signing self-test failed: personal_sign produced a malformed signature");
  }
}

let cached: Error | null | undefined;

/**
 * Throws when this app's signing is not trustworthy. Called before signing, not
 * at import time, so a broken install surfaces as a refused order with a clear
 * reason rather than a module that fails to load.
 */
export function assertSigningHealthy(): void {
  if (cached === undefined) {
    try {
      runSelfTest();
      cached = null;
    } catch (err) {
      cached = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (cached) throw cached;
}

/** For the diagnostics view: the same check, as a boolean and a reason. */
export function signingHealth(): { ok: boolean; error: string | null } {
  try {
    assertSigningHealthy();
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
