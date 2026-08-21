<div align="center">

# 📊 Funding Rate Market

### ⚡ Delta-neutral funding-rate arbitrage across **10** perpetual venues

*Stream every funding rate. Rank the widest gaps. Hold both legs — on paper, or for real.* 💸

<br/>

![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/node:sqlite-built--in-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)

![Venues](https://img.shields.io/badge/venues-10-8B5CF6?style=flat-square)
![Live trading](https://img.shields.io/badge/live%20trading-8%20venues-22C55E?style=flat-square)
![Strategies](https://img.shields.io/badge/strategies-4-F59E0B?style=flat-square)
![Dependencies](https://img.shields.io/badge/runtime%20deps-15-64748B?style=flat-square)
![Self-hosted](https://img.shields.io/badge/self--hosted-no%20telemetry-EC4899?style=flat-square)

</div>

<br/>

> 🔒 **Everything runs locally.** No hosted component, no telemetry, no accounts.
> One password guards the app **and** derives the key that encrypts every stored
> secret.

---

## 📑 Table of contents

| | Section | |
| :--: | --- | --- |
| 🎯 | [What it does](#-what-it-does) | Market data, dashboards, trading, strategies |
| 🛠️ | [Requirements](#-requirements) | Node 22.5+ and nothing else |
| 🚀 | [Getting started](#-getting-started) | Three commands |
| ⚙️ | [Configuration](#-configuration) | Three variables, two of them locks |
| 🏦 | [Venue support](#-venue-support) | What a credential buys, per venue |
| 🛡️ | [Security](#-security) | One password, and how it is defended |
| 🧱 | [Notes on the stack](#-notes-on-the-stack) | And why Vercel will not work |

---

## 🎯 What it does

### 📡 Market data

Ten venues stream **simultaneously**:

<table>
<tr>
<td valign="top" width="50%">

**🏛️ Centralized — 6**

- Binance
- Bybit
- OKX
- KuCoin
- Gate.io
- Bitget

</td>
<td valign="top" width="50%">

**⛓️ On-chain — 4**

- Hyperliquid
- Aster
- Lighter
- edgeX

</td>
</tr>
</table>

Rates are **normalized to the shortest funding interval** among the venues listing
that coin, so an hourly venue is comparable with an eight-hourly one. Nothing about
the market is persisted — on restart it is rebuilt from the venues' own feeds. 🔄

> 🎯 **The loop is deliberately narrow.** Every pair is fetched over REST once a
> minute, sorted by absolute funding rate, and **only the top ten per venue are
> subscribed**. That keeps a small VPS viable and concentrates attention on the pairs
> actually worth farming.

### 🖥️ Three dashboards, not one filtered table

| Dashboard | Scope |
| --- | --- |
| 🔀 **Cross CEX–DEX** | One custodial leg against one on-chain leg |
| 🏛️ **CEX only** | Centralized venues against each other |
| ⛓️ **DEX only** | On-chain venues against each other |

Each one **re-derives** the funding difference under its own venue scope, because the
best pair within a subset is not the best pair overall. 📐

### 💱 Manual trading

A ticket that sizes in **USD**, shows the estimated liquidation price and the
round-trip cost *before* you commit, and closes a position — or a whole hedge — by
percentage. 🎚️

### 🤖 Four automated strategies

Each is deployable several times over, with its own venues and thresholds.

| | Strategy | 💰 Earns from | ⏱️ Typical hold | 🛑 Stop-loss |
| :--: | --- | --- | --- | :--: |
| 1️⃣ | **FundingSync** | The funding difference at one settlement | Minutes → hours | ❌ |
| 2️⃣ | **PerpBridge** | A price gap between two venues converging | Unbounded | ❌ |
| 3️⃣ | **FundingBridge** | Funding, but waits for a cheap entry first | Minutes → hours | ❌ |
| 4️⃣ | **FundingYield** | Net USD yield across several settlements | Hours → days | ✅ |

📚 The **Strategy Library** page documents each one in full: what it earns from, how
it decides, every exit condition, what it ignores, and how it loses money.

### 🏧 Treasury rebalancing

Moves collateral between venues when one drifts toward a margin call.

- 🔐 Withdrawal addresses are **inert until explicitly armed**
- ❌ Arming is refused server-side if the venue reports a *different* deposit address
- 🔒 Unattended transfers need an environment arm on top of the in-app toggle

---

## 🛠️ Requirements

| | Requirement | Why |
| :--: | --- | --- |
| ✅ | **Node 22.5 or newer** | The database is Node's built-in `node:sqlite` — no native build step, no C++ toolchain |
| 🚫 | Nothing else | No Docker, no external database, no Redis |

---

## 🚀 Getting started

```bash
npm install
cp .env.example .env.local   # 🔑 then set APP_PASSWORD
npm run dev
```

🌐 Open <http://localhost:3000> and sign in with that password.

💾 The database is created at `data/app.db` on first run and migrated in place on
every start. `data/` is gitignored.

---

## ⚙️ Configuration

Everything not listed below — exchange credentials, fees, strategy settings,
withdrawal addresses — is configured **in the dashboard** and stored encrypted in the
database. There are only three variables, and two of them are locks. 🔐

| Variable | Required | Purpose |
| --- | :--: | --- |
| 🔑 `APP_PASSWORD` | ✅ | The one secret. Signing in authorises every route that can move money, and every stored secret is encrypted with a key derived from it. |
| 🤖 `AUTO_TRADING` | ⬜ | Arms the strategy engine for the **live** account. Unset, strategies still evaluate every cycle and log what they *would* have done — but send no order. |
| 🏧 `REBALANCE_AUTOMATION` | ⬜ | Arms unattended treasury transfers. Unset, the engine logs what it would move and moves nothing. |

> ⚠️ **Changing `APP_PASSWORD` invalidates every session and makes stored credentials
> and withdrawal addresses unreadable.** There is no recovery path — that is the trade
> for having no key management.

🎛️ Each in-app toggle is **necessary but not sufficient**. Arming automation requires
editing `.env.local` and restarting, deliberately, so that an irreversible unattended
action is never one mis-click away.

---

## 🏦 Venue support

Market data works for **all ten venues without any credential**. What a credential
buys differs per venue — and the differences are not a matter of remaining work. Each
is a property of how the venue authenticates. 🔍

| Venue | 🎫 Credential | 👁️ Read | 📈 Trade live |
| --- | --- | --- | --- |
| 🏛️ Binance, Bybit, OKX, KuCoin, Gate.io, Bitget | API key + secret (+ passphrase on OKX, KuCoin, Bitget) | ✅ | ✅ |
| 💠 Hyperliquid | Wallet address; private key optional | ✅ from the address alone | ✅ with the key |
| 🌟 Aster | Master account address + API wallet private key | ✅ key required | ✅ |
| ⚡ edgeX | API key + secret + passphrase | ✅ | ⚠️ cancel only |
| 🪶 Lighter | None accepted | ❌ | ❌ |

🔐 Hyperliquid and Aster orders are signed **locally** with a wallet key, using
`@noble/curves` and `@noble/hashes` rather than a wallet library — so what actually
signs a real order fits in one readable file (`lib/private/eip712.ts`). That code
**reproduces the signature vectors** published with EIP-712, EIP-55 and Hyperliquid's
own SDK tests before it will sign anything. If those checks fail, orders are refused
rather than attempted. ✋

💡 Aster needs its private key even to *read*, because it has no public account
endpoint. Hyperliquid reads from a public address alone, which is a genuinely useful
configuration — it exposes nothing.

<details>
<summary><b>⚡ Why edgeX cannot open a position</b></summary>

<br/>

It authenticates reads and cancellations with an HMAC header, but *opening* a
position needs a **second signature** from a separate trading key, over amounts
rescaled by per-contract resolution factors inside a nested typed struct.

edgeX's own documentation host does not resolve, so that payload cannot be verified
against anything but SDK source — and a wrong scaling factor is **not** a rejected
order, it is an order for the wrong size. 😬

So the venue is readable and its resting orders can be cancelled; order entry is
refused rather than guessed at.

</details>

<details>
<summary><b>🪶 Why Lighter is market data only</b></summary>

<br/>

It signs L2 transactions with a Schnorr signature over the **ECgFp5 curve** using
Poseidon2 hashing. No JavaScript implementation of that curve exists, official or
otherwise — the reference signer is a Go binary, and the npm package that *looks*
official contains REST models and no signer at all.

Shipping an unaudited WASM blob into the path that moves money is a worse trade than
saying the venue is market data only. 🤷

</details>

---

## 🛡️ Security

One password is the **entire** authentication surface, and it is used two ways:

- 🚪 Signing in with it authorises every route that can move money
- 🔐 A key derived from it encrypts every credential in the database

🍪 Sessions are **signed cookies** rather than server-side records, so changing the
password invalidates all of them for free.

### 🚦 Sign-in throttle

One password and no user list is exactly the shape brute force likes, so the cost of
a wrong guess rises in two steps:

| | Event | Consequence |
| :--: | --- | --- |
| ⏳ | A wrong password | **10 second** wait before the next attempt |
| 🔒 | Three wrong **in a row** | Sign-in locked for **6 hours** |

3️⃣ Three is enough for a typo and a retry; it is not enough to search anything. The
10 second gap alone caps an attacker at **six guesses a minute** — the difference
between a dictionary run finishing this week and never finishing.

🌍 The counter is **global** rather than per-address. There is one password, so
"somebody guessed wrong three times" is the whole signal; keying it by IP would hand
a distributed attacker three free attempts per host.

🔁 Both timers live in memory, and that is the **recovery path**: restarting the
server clears the lock. It needs host access, which already implies being able to
read `APP_PASSWORD` out of `.env.local` — so it adds no attack surface, and it means
there is **no password-reset flow to attack instead**.

⚡ Nothing sleeps server-side either. A refused attempt returns *immediately* with
the remaining wait, because holding the connection open for the full delay would turn
the throttle into its own denial-of-service.

🕐 The login page shows a live countdown, so a six-hour lock reads as a lock rather
than as a broken form.

### 📋 Worth doing, and not handled by this repo

- 🔏 **Put the app behind a reverse proxy with TLS.** The session cookie is only
  marked `secure` when the request arrives over HTTPS.
- 🚫 **Do not expose port 3000** to the internet once a proxy is in front of it.
- 🧱 **Restrict who can reach the app at all** — a firewall rule or a VPN is a
  stronger control than any password. An attacker with shell access does not need the
  app's password: `.env.local` is right there.

---

## 🧱 Notes on the stack

**Next.js 16** (App Router, Turbopack) · **React 19** · **Tailwind v4** ·
`@base-ui/react` for UI primitives.

📦 Fifteen runtime dependencies in total. The four that matter:

| Package | For |
| --- | --- |
| `ws` | The venue websockets |
| `@noble/curves` | secp256k1 signing |
| `@noble/hashes` | keccak256 |
| `@msgpack/msgpack` | Hyperliquid's action encoding |

🖥️ Deployment is `npm run build && npm start` on a machine you control.

> ❌ **Vercel and similar platforms will not work.** The app holds long-lived
> websocket connections to every venue and writes to a local SQLite file — neither
> survives a serverless request boundary.

<div align="center">

<br/>

**⚠️ This software places real orders with real money. Read the Strategy Library
before arming anything. ⚠️**

</div>
