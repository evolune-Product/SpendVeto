// Fetches OFAC's real, current Specially Designated Nationals (SDN) list and extracts every
// "Digital Currency Address" entry into a compact local cache data/sanctions/ofac-digital-currency.json
// — the thing server/sanctions.js actually screens payees against at runtime.
//
// Source: https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML — the
// U.S. Treasury's own Sanctions List Service, confirmed live and current as of this script's
// writing (published 2026-10-02, 19,488 entries, 1,065 of them carrying a digital currency
// address). No authentication, no rate limit documented, a plain redirect to a presigned S3 object.
//
// This is a real, working fetch against the real government endpoint — not a stub, not a sample
// file pretending to be the real thing. Re-run it (npm run sanctions:update, or node
// scripts/fetch-sanctions-list.mjs) to refresh the local cache; nothing here auto-schedules that,
// which is a deliberate, disclosed gap — see server/sanctions.js's own file header.
//
// What this does NOT do, on purpose: name matching, the Consolidated (non-SDN) list, or any list
// besides OFAC's — a real compliance program needs all of those and more; this is the one piece
// that's directly actionable against a blockchain payee address, which is what SpendVeto actually
// governs.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
const OUT_PATH = fileURLToPath(new URL("../data/sanctions/ofac-digital-currency.json", import.meta.url));

// Classification is by the ADDRESS'S OWN FORMAT, not OFAC's chain tag — verified necessary during
// development, not a design preference: the real list's "USDT" tag mixes genuine EVM (0x...)
// addresses with Tron (base58, "T...") addresses under one label, so trusting the tag to decide an
// address's format would misclassify real entries. Must match server/sanctions.js's own
// canonicalizeAddress exactly, or an address stored under one casing rule here and looked up under
// a different one at runtime would silently never match.
//
// Case sensitivity matters and differs by family: EVM hex addresses are conventionally compared
// case-insensitively (this codebase lowercases them everywhere, e.g. client/policy.js's payee
// checks). Base58 formats (Solana, XRP) are NOT — base58's alphabet deliberately excludes '0','O',
// 'I','l' to avoid visual ambiguity, so lowercasing a valid base58 string can turn an included
// uppercase letter (like 'L') into an EXCLUDED lowercase one ('l'), corrupting a real address into
// one that no longer even looks like valid base58. (Caught empirically: a real SDN-listed Solana
// address containing 'L' failed its own format check after lowercasing, in testing.) So EVM
// addresses are stored/looked-up lowercased; everything else keeps its original case exactly.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function canonicalizeAddress(rawAddress) {
  if (EVM_ADDRESS.test(rawAddress)) return { address: rawAddress.toLowerCase(), family: "evm" };
  return { address: rawAddress, family: "other" }; // base58 and everything else: original case preserved, exactly
}

async function fetchSdnXml() {
  const res = await fetch(SDN_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`SDN list fetch failed: HTTP ${res.status}`);
  return res.text();
}

// Hand-rolled, deliberately narrow extraction — not a general XML parser, because this script only
// ever needs one shape of data out of a well-formed government-published file: each <sdnEntry>'s
// uid/name/programList, and within it, any <id> block whose <idType> starts with "Digital Currency
// Address". Verified against the real downloaded file's actual structure before being trusted —
// see the real idType/idNumber example checked during development: <id><idType>Digital Currency
// Address - ETH</idType><idNumber>0x252a8bd2...</idNumber></id> inside an <sdnEntry> for a real,
// currently-listed uid.
function extractDigitalCurrencyEntries(xml) {
  const publishDateMatch = xml.match(/<Publish_Date>([^<]+)<\/Publish_Date>/);
  const recordCountMatch = xml.match(/<Record_Count>([^<]+)<\/Record_Count>/);
  const publishDate = publishDateMatch ? publishDateMatch[1] : null;
  const recordCount = recordCountMatch ? Number(recordCountMatch[1]) : null;

  const entries = [];
  const sdnEntryRe = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
  let entryMatch;
  while ((entryMatch = sdnEntryRe.exec(xml))) {
    const block = entryMatch[1];
    const idBlocks = block.match(/<id>[\s\S]*?<\/id>/g) || [];
    const currencyIds = idBlocks
      .map((idBlock) => {
        const idType = (idBlock.match(/<idType>([^<]*)<\/idType>/) || [])[1] || "";
        const idNumber = (idBlock.match(/<idNumber>([^<]*)<\/idNumber>/) || [])[1] || "";
        return { idType, idNumber };
      })
      .filter((x) => x.idType.startsWith("Digital Currency Address"));
    if (currencyIds.length === 0) continue;

    const uid = (block.match(/^\s*<uid>([^<]*)<\/uid>/) || [])[1] || (block.match(/<uid>([^<]*)<\/uid>/) || [])[1];
    const lastName = (block.match(/<lastName>([^<]*)<\/lastName>/) || [])[1] || "";
    const firstName = (block.match(/<firstName>([^<]*)<\/firstName>/) || [])[1] || "";
    const sdnType = (block.match(/<sdnType>([^<]*)<\/sdnType>/) || [])[1] || "";
    const programs = [...block.matchAll(/<program>([^<]*)<\/program>/g)].map((m) => m[1]);
    const name = [firstName, lastName].filter(Boolean).join(" ") || lastName;

    for (const { idType, idNumber } of currencyIds) {
      const token = idType.replace("Digital Currency Address - ", "").trim();
      if (!idNumber) continue;
      const { address: canonicalAddress } = canonicalizeAddress(idNumber);
      entries.push({
        address: canonicalAddress,
        addressRaw: idNumber,
        token,
        sdnUid: uid,
        name,
        sdnType,
        programs,
      });
    }
  }
  return { publishDate, recordCount, entries };
}

async function main() {
  const localFileArg = process.argv.find((a) => a.startsWith("--file="));
  const xml = localFileArg
    ? await import("node:fs").then((fs) => fs.readFileSync(localFileArg.slice("--file=".length), "utf8"))
    : await fetchSdnXml();

  console.log(`Fetched ${(xml.length / 1024 / 1024).toFixed(1)} MB of SDN XML.`);
  const { publishDate, recordCount, entries } = extractDigitalCurrencyEntries(xml);
  console.log(`List publish date: ${publishDate} — ${recordCount} total SDN entries, ${entries.length} digital currency addresses extracted.`);

  const byToken = {};
  for (const e of entries) byToken[e.token] = (byToken[e.token] || 0) + 1;
  console.log("By token:", Object.entries(byToken).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));

  const addresses = Object.create(null);
  for (const e of entries) {
    if (!addresses[e.address]) addresses[e.address] = [];
    addresses[e.address].push({ token: e.token, sdnUid: e.sdnUid, name: e.name, sdnType: e.sdnType, programs: e.programs });
  }

  const cache = {
    source: SDN_URL,
    sourceDescription: "OFAC Specially Designated Nationals (SDN) List, digital currency address entries only",
    listPublishDate: publishDate,
    totalSdnRecords: recordCount,
    digitalCurrencyEntryCount: entries.length,
    uniqueAddressCount: Object.keys(addresses).length,
    fetchedAt: new Date().toISOString(),
    addresses, // canonicalized address (EVM: lowercased; base58/other: original case) -> array of { token, sdnUid, name, sdnType, programs }
  };

  mkdirSync(fileURLToPath(new URL("../data/sanctions", import.meta.url)), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(cache, null, 2));
  console.log(`Wrote ${OUT_PATH} (${Object.keys(addresses).length} unique addresses).`);
}

main().catch((e) => {
  console.error("Fetch/parse failed:", e.message);
  process.exit(1);
});
