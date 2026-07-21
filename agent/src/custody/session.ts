// Per-user session keys for non-custodial auto-trading. Each key is DERIVED
// deterministically from one backend master secret + the user's wallet address,
// so no per-user private key is ever stored anywhere. The key is scope-limited
// on-chain by the user's Roles module (it can trade but provably cannot
// withdraw — see the Phase 0 spike), so even a master-secret compromise has a
// bounded blast radius: an attacker could trigger trades within users' vaults,
// never move funds out.
//
// Custody is OFF unless CUSTODY_SESSION_MASTER is set (>= 32 chars), so this
// ships dormant and nothing changes until it's deliberately configured.
import { keccak256, encodePacked, toHex, getAddress, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const MASTER = (process.env.CUSTODY_SESSION_MASTER ?? "").trim();

export function custodyEnabled(): boolean {
  return MASTER.length >= 32;
}

/**
 * The scoped session key for a wallet. Deterministic: same wallet always maps
 * to the same key, derived from the master secret, so we can recompute it on
 * any box without a key store. Domain-separated by a version label so the
 * scheme can be rotated.
 */
export function sessionAccountFor(userAddress: string): PrivateKeyAccount {
  if (!custodyEnabled()) throw new Error("custody_disabled");
  const owner = getAddress(userAddress);
  // pk = keccak256( keccak256(master) || owner || label )
  const masterHash = keccak256(toHex(MASTER));
  const pk = keccak256(encodePacked(["bytes32", "address", "string"], [masterHash, owner, "meridian.session.v1"]));
  return privateKeyToAccount(pk);
}

export function sessionAddressFor(userAddress: string): Address {
  return sessionAccountFor(userAddress).address;
}
