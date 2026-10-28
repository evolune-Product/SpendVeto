// Browser only — bundled into the Console's sign-in and the site's signup
// form. Finds the wallets installed in this browser the EIP-6963 way (each
// extension announces itself, so MetaMask, Rabby, Coinbase and the rest can
// sit side by side), falling back to window.ethereum for wallets that predate
// it. No SDK: wallets are reached through the provider they inject.

export function discoverWallets(waitMs = 300) {
  return new Promise((resolve) => {
    const found = new Map();
    const onAnnounce = (e) => {
      const { info, provider } = e.detail || {};
      if (info?.uuid && provider && !found.has(info.uuid)) found.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const wallets = [...found.values()];
      if (!wallets.length && window.ethereum) wallets.push({ id: "injected", name: window.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: null, provider: window.ethereum });
      resolve(wallets);
    }, waitMs);
  });
}

const toHex = (text) => "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");

// Asks the wallet for its address, gets the message to sign for it from
// `challengeFor(address)` (the server writes it: domain, nonce, expiry), and
// signs it with personal_sign — a signature, never a transaction or gas.
export async function signChallenge(wallet, challengeFor) {
  const [address] = await wallet.provider.request({ method: "eth_requestAccounts" });
  if (!address) throw new Error("the wallet didn't share an address");
  const message = await challengeFor(address);
  const signature = await wallet.provider.request({ method: "personal_sign", params: [toHex(message), address] });
  return { address, message, signature };
}

// What to show when a wallet call fails: a cancelled prompt is the user's
// choice, not an error worth alarming them about.
export function walletErrorText(err) {
  if (err?.code === 4001 || /reject|denied|cancel/i.test(err?.message || "")) return "You cancelled in your wallet.";
  if (err?.code === -32002) return "Your wallet already has a request open — finish or close it there first.";
  return err?.message || "The wallet request failed.";
}
