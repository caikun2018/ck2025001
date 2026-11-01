# Cuoti Zhilian

English | [简体中文](./README.md)

An AI-powered wrong-question learning loop WeChat Mini Program for elementary school students: **capture a mistake by photo or voice → archive it to the Lexiang knowledge base → AI generates similar questions (challenge / mock exam / original practice) → auto-retire it once answered correctly N times in a row**.

Built on native WeChat Mini Program APIs. **No framework, no npm dependencies, no build step** — just import the folder into WeChat DevTools and run.

## How it works

1. **Capture**: photo / voice / handwriting / document upload — AI turns it into a structured record (subject, knowledge point, root cause, difficulty)
2. **Archive**: writes to the Lexiang knowledge base under a `grade → subject → {wrong questions, study memory, question bank}` hierarchy
3. **Generate**: AI creates similar questions weighted by mistake frequency plus your weak-point list; a pre-generated question bank keeps the wait near zero
4. **Answer**: voice-first input with keyboard fallback, plus a handwriting pad for working out equations
5. **Grade and retire**: hitting the threshold of consecutive correct answers retires the question and drops the knowledge point from your weak-point list

## Tech stack

- Native WeChat Mini Program (no third-party UI library)
- Storage: the **Lexiang knowledge base** is the single source of truth; local `storage` acts as a cache layer
- LLM: any OpenAI-compatible endpoint (ten-plus providers preconfigured in `utils/config.example.js`)
- Document parsing: `utils/fileParser.js` handles docx / xlsx / pptx / pdf in-process; DEFLATE decompression is implemented in-house from RFC 1951, with no third-party library

## Getting started

1. Open WeChat DevTools → Import Project → select the repository root
2. Copy the config template and fill in your own values:

   ```bash
   cp utils/config.example.js utils/config.js
   ```

3. Create an app on the Lexiang open platform to obtain your `appKey` / `appSecret`; build the folder hierarchy above, then fill the `entryId` values into `config.js`
4. Deploy the proxy: right-click `cloudfunctions/lexiang-proxy` → Upload and Deploy (cloud install dependencies), then set the credentials as cloud function environment variables
5. Build and preview

### Why a proxy is required

A WeChat Mini Program cannot customize its User-Agent on real devices, and the Lexiang WAF rejects mobile UAs with a 404 page. Real-device requests therefore have to be relayed by a server. Pick any one of these three channels:

| Channel | Path | Best for |
| --- | --- | --- |
| WeChat Cloud Function | `cloudfunctions/lexiang-proxy` | Recommended, native integration |
| Tencent Cloud SCF | `cloudfunctions/scf-lexiang-proxy` | Domestic access, free tier |
| Cloudflare Workers | `cloudflare-worker.js` | If you already use Cloudflare |

All three speak the same protocol (`{action: 'token' | 'request'}`) and read credentials from the environment variables `LX_APP_KEY` / `LX_APP_SECRET` / `LX_STAFF_ID`.

**You must also configure the caller verification key `LX_PROXY_KEY`**: set it as a server environment variable, and put the same value into `LEXIANG_PROXY_KEY` in your Mini Program `config.js`; it is sent as the `x-proxy-key` header. Without it the server rejects every request (an intentional secure default) — with no such check, anyone holding your function URL can trade it for a token.

## Security notes (please read first)

- `utils/config.js` is **gitignored** because it holds your real credentials. Commit only `config.example.js`
- The app `appSecret` grants full read/write access to your knowledge base. **Leave it empty** and supply it through cloud function environment variables instead — when it is empty, `lexiang.js` falls back to the cloud function channel automatically
- Once a credential enters Git history it is compromised. Deleting the file does not help; you must reissue it on the open platform
- **None of the three proxies authenticates its callers by default.** Once deployed publicly (an SCF function URL with "no auth", or a Cloudflare Worker), anyone who knows the address can obtain a token and read or write your knowledge base. Add your own check before going live: an `OPENID` allowlist for WeChat cloud functions, or a shared-secret request header plus rate limiting for public proxies

## Asset licensing

The cartoon illustrations and badges under `assets/` are AI-generated and are **not covered by the MIT license**. Do not use them commercially. The source code itself is MIT licensed — see [LICENSE](./LICENSE).

## Disclaimer

This is a personal project for educational use and is not affiliated with Lexiang. When using it, comply with the Lexiang open platform terms of service and the WeChat Mini Program operating rules.
