# The SpendVeto network formats

Three open formats, each implemented in this repository and pinned by `npm run verify`. Anyone may implement them; none requires running SpendVeto, calling a SpendVeto service, or asking permission.

| Format | Version | Reference implementation | Purpose |
|---|---|---|---|
| Governed-spend attestation | `sva1` | `server/attestations.js` (pure, viem only) | A seller checks that a buyer's spend passed a policy engine before accepting the payment |
| Reputation feed | `spendveto-reputation-feed/v1` | `server/reputation.js` | Organizations share counterparty fraud reports as signed hashes |
| Policy | `https://spendveto.com/schemas/policy-v1.json` | `spec/policy-v1.schema.json` + `server/policyspec.js` | One file states an agent's limits across rails |

All signatures are EIP-191 `personal_sign` over secp256k1, so they verify with any Ethereum library (viem `recoverMessageAddress`, ethers `verifyMessage`, `eth_account`) and no SpendVeto code. Each format signs under its own message prefix, so a signature made for one can never be presented as another, even when one key signs all three.

## Issuer identity

A SpendVeto instance publishes its identity at `GET /.well-known/spendveto-issuer.json`:

```json
{
  "spec": "spendveto-issuer/v1",
  "issuer": "0xB8d9…0ea6",
  "persistent": true,
  "attestations": { "format": "sva1.<base64url claims>.<0x signature>", "header": "X-SpendVeto-Attestation", "messagePrefix": "spendveto-attestation:v1:", "ttlSeconds": 300 },
  "reputation": { "spec": "spendveto-reputation-feed/v1", "feed": "/api/reputation/feed", "messagePrefix": "spendveto-reputation-feed:v1:" },
  "policySchema": "https://spendveto.com/schemas/policy-v1.json"
}
```

The document is a convenience, not a trust anchor: a verifier pins the `issuer` address it trusts, the way a browser pins a root certificate. `persistent: false` means the instance runs with a per-process key (no `SERVER_SIGNER_KEY`), so its address changes on restart; production issuers set the key.

## 1. Governed-spend attestation (`sva1`)

### Token

```
sva1.<payload>.<signature>
```

- `payload` is the base64url (no padding) encoding of a UTF-8 JSON object of claims.
- `signature` is a 65-byte `0x`-hex EIP-191 signature over the ASCII string `spendveto-attestation:v1:` followed by `payload` exactly as it appears in the token. Signing the encoded bytes removes any canonicalization step for two implementations to disagree on.
- Transport: the HTTP header `X-SpendVeto-Attestation`, sent with the payment request.

### Claims

| Claim | Type | Meaning |
|---|---|---|
| `v` | integer | Always `1` |
| `iss` | address | The issuer: the address the signature must recover to |
| `sub` | string | The payer (EVM addresses lowercased) |
| `aud` | string or null | The payee the spend was checked against (null for first-party catalog tools) |
| `res` | string | The resource being paid for |
| `amt` | decimal string | The USD ceiling the policy allowed |
| `cur` | string | `"USD"` |
| `rail` | string | `x402`, `card`, `payout`, `llm`, `api`, `ap2`, `acp` or `mpp` |
| `chain` | string | Optional settlement chain id |
| `pol` | hex string | SHA-256 of the policy in force (canonical key order) |
| `dec` | string | `allowed`, or `approved` when a human signed off |
| `apr` | string | The approval id, when `dec` is `approved` |
| `iat`, `exp` | integer | Unix seconds; at most 900 seconds apart |
| `jti` | string | Unique id, for single-use enforcement |

The issuer mints only after its policy engine allowed the spend, and above its approval threshold only after an approved, unconsumed approval exists. The policy's limits are deliberately absent: a seller learns that a policy governed the spend and which version, not how much the buyer can spend.

### Verification

A verifier MUST, in this order, and refuse on the first failure:

1. Parse the token. Reject anything that isn't three dot-separated parts, prefix `sva1`, a base64url JSON object and a 65-byte hex signature (`attestation_malformed`); reject `v` other than 1 (`attestation_unsupported_version`).
2. Refuse when its trusted-issuer list is empty (`attestation_no_trusted_issuers`). There is no "accept any issuer" mode: anyone can run an issuer with a permissive policy.
3. Recover the signer from the signature and require it to equal `iss` (`attestation_bad_signature`), then require it to be a trusted issuer (`attestation_untrusted_issuer`).
4. Check time with at most 60 seconds of clock skew: `iat` not in the future (`attestation_not_yet_valid`), `exp` not passed (`attestation_expired`), `exp − iat` within the verifier's maximum (`attestation_ttl_too_long`).
5. When the verifier knows them: `aud` is one of its payee identifiers (`attestation_audience_mismatch`), `res` is the resource requested (`attestation_resource_mismatch`), `amt` covers the price (`attestation_amount_insufficient`), and `sub` is the wallet actually paying (`attestation_payer_mismatch`). Checking the payer is what stops a borrowed attestation from vouching for someone else's payment.
6. Accept each `jti` once while it is valid (`attestation_replayed`).

`integrations/seller-express.js` does all of this as Express middleware.

### What an attestation does not prove

It does not prove the payment happened, which is the rail's job, or that the issuer's policy is strict. It proves the named issuer's engine said yes to this payer, payee, resource and ceiling at that time.

## 2. Reputation feed (`spendveto-reputation-feed/v1`)

### Subjects

A counterparty is identified by the SHA-256 (lowercase hex) of the ASCII string `spendveto-rep:v1:` followed by its canonical form:

| Input | Canonical form |
|---|---|
| `0x`-hex (EVM, Aptos) | lowercased |
| `http(s)://` URL | its hostname, lowercased |
| contains `@` (email, UPI VPA) | lowercased |
| `kind:value` (e.g. `card-merchant:4445550001`) | kind lowercased, value as written |
| IBAN passing the ISO 13616 mod-97 check | uppercased, spaces removed |
| a dotted name containing a letter (domain) | lowercased |
| anything else (base58, XRPL, Hedera ids, provider ids) | as written; case-sensitive formats keep their case |

The prefix separates these hashes from any other use of SHA-256. It is not a secret. Anyone who can guess an identifier can hash it and look it up, so a feed hides identifiers from a casual reader, not from a determined one.

### Document

```json
{
  "spec": "spendveto-reputation-feed/v1",
  "publisher": "0x…",
  "name": "Acme Corp",
  "issuedAt": "2026-10-18T14:55:21.286Z",
  "entries": [
    { "subject": "<64 hex>", "kind": "scam", "severity": "block", "count": 2, "firstSeen": "…", "lastSeen": "…" }
  ],
  "digest": "<64 hex>",
  "signature": "0x…"
}
```

- `kind` is one of `scam`, `fraud`, `prompt_injection`, `non_delivery`, `chargeback`, `malware`, `impersonation`, `other`. `severity` is `block` or `review`.
- `digest` is the SHA-256 of the canonical JSON (keys sorted recursively, no whitespace) of `{spec, publisher, name, issuedAt, entries}`.
- `signature` is EIP-191 over `spendveto-reputation-feed:v1:` followed by `digest`, by `publisher`.
- Reasons, raw identifiers, amounts and customer data never appear in a feed. A report marked `share: false` stays on the instance that filed it.

### Import rules

A subscriber MUST refuse a feed when: the digest doesn't match the content (`feed_digest_mismatch`), the signature doesn't recover to `publisher` (`feed_bad_signature`), it trusts no publishers (`feed_no_trusted_publishers`) or not this one (`feed_publisher_not_trusted`), `issuedAt` is in the future, or it already holds a feed from that publisher issued at or after this one (`feed_stale`). The last rule is rollback protection: an old feed can't be replayed to resurrect an entry the publisher has since withdrawn. A newer feed replaces the publisher's previous one in full.

### Effect

A subscriber decides what an imported entry does. SpendVeto's rule: a local `block` refuses; an imported `block` refuses under `importedAction: "deny"` (the default) or goes to a human under `"review"`; any `review` goes to a human. Removing a publisher from the trusted list stops its entries from counting immediately. A card authorization can't wait for a human, so on cards `review` declines.

## 3. Policy (`policy-v1`)

The schema is `spec/policy-v1.schema.json` (JSON Schema 2020-12), served with CORS at `https://spendveto.com/schemas/policy-v1.json`. Add `"$schema": "https://spendveto.com/schemas/policy-v1.json"` to a policy file and editors that understand JSON Schema will autocomplete and check it.

- Every key is optional and falls back to its documented default.
- Unknown keys are errors. A misspelled limit is never read, so it fails open; the validator names the key you probably meant.
- Keys starting with `$` or `x-` are reserved for comments and extensions and are never interpreted.
- The reference validator implements exactly the keywords the schema uses and refuses to load a schema that uses others, so no rule in the schema can go silently unenforced. It adds checks the schema can't express: chain ids must be registered, and limits that contradict each other (an approval threshold above the per-call cap, an hourly budget above the daily one) are warnings.

Validate with `spendveto validate policy.json [--strict]` or `POST /api/policy/validate`.

## Versioning

A breaking change ships as a new version (`sva2`, `…/v2`, `policy-v2.json`), and the reference implementation keeps accepting the previous version for at least one release. Additions old verifiers can safely ignore, such as a new attestation claim or a new feed field, stay within the version. New optional policy keys are also added to the v1 schema in place. Because unknown keys are errors, a validator older than a key reports it as unknown, so validate with the schema that ships with the engine you deploy.
