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

- Native WeChat Mini Program development (no third-party UI library)
- Storage: **the Lexiang knowledge base is the single source of truth**; local `storage` is a cache/acceleration layer only
- LLM: any OpenAI-compatible endpoint (a dozen providers are pre-listed in `utils/config.example.js`)
- Document parsing: `utils/fileParser.js` handles docx / xlsx / pptx / pdf in-house; DEFLATE decompression is implemented from RFC 1951 with no third-party library

## Project layout

| Path | Purpose |
| --- | --- |
| `app.js` / `app.json` / `app.wxss` | Entry point, page registration, global styles |
| `pages/` | 13 pages (login, AI assistant, wrong-answer entry/detail, challenges, drills, achievements, settings) |
| `services/lexiang.js` | Knowledge-base read/write and sync (token, folders, wrong answers, study memory, question bank, progress) |
| `services/llm.js` | Model calls (streaming and vision) |
| `services/bank.js` / `progress.js` / `storage.js` / `auth.js` | Question-bank warm-up, progress, local cache, login |
| `utils/config.js` | Your configuration (template is `config.example.js`; the real file is git-ignored) |
| `utils/fileParser.js` / `crypto.js` / `util.js` | Document parsing, local obfuscation, helpers |
| `cloudfunctions/lexiang-proxy/` | WeChat Cloud Development function proxy (recommended) |
| `cloudfunctions/scf-lexiang-proxy/` | Tencent Cloud SCF proxy |
| `cloudflare-worker.js` | Cloudflare Workers proxy |
| `tools/lexiang-check.js` | Deployment self-check: validates credentials and knowledge-base coordinates |
| `assets/` | AI-generated illustrations (not covered by the MIT license) |

## Deployment guide

> Expect 40–60 minutes from zero to a working build on a real device. Follow the order; **steps 3 and 4 are where people get stuck**.
> Every step ends with something you can verify. If you get stuck, check the [troubleshooting table](#troubleshooting).

### Step 0 — What you need

| Item | Purpose | Required |
| --- | --- | --- |
| WeChat Mini Program AppID | Import, device preview, release | Yes (an individual account works) |
| Lexiang account + an open-platform app | The only place wrong answers, study memory and question banks live | Yes |
| An OpenAI-compatible LLM API key | Question generation, explanations, grading | Yes |
| An API proxy (WeChat Cloud Dev / Tencent SCF / Cloudflare — pick one) | Bypasses the Lexiang WAF | Yes, for real devices |
| Node.js ≥ 16 | Running the self-check script, generating keys | Recommended |

One thing that is easy to misjudge: **if you only preview inside WeChat DevTools, you do not need a proxy** (the tool reaches Lexiang directly). **A real device always needs one** — see [Why a proxy is required](#why-a-proxy-is-required).

### Step 1 — Import the project

1. WeChat DevTools → "Import project" → select this repository's root directory
2. **Replace the AppID with your own.** `project.config.json` ships with the author's AppID; keeping it means your cloud environment and uploads land in someone else's account.
   - Have an AppID: enter it
   - Have none: choose "Test account". Note that **test accounts cannot use Cloud Development**, so you must use the SCF or Cloudflare channel
3. Do **not** run `npm install` — there are no npm dependencies at the project root; the only `package.json` lives inside the cloud function and is installed by the cloud runtime

### Step 2 — Create your config file

```bash
cp utils/config.example.js utils/config.js
```

`utils/config.js` is git-ignored, so it is safe to put real credentials in it. Only the sanitized template `config.example.js` is committed.

### Step 3 — Prepare the Lexiang knowledge base (the hard part)

You need five values: `appKey`, `appSecret`, `teamId`, `spaceId`, `rootEntryId`.

**3.1 Create an app and get `appKey` / `appSecret`**

Sign in to the Lexiang open platform → "My apps" → create an app. Copy `appKey` and `appSecret` somewhere safe — they grant read/write access to your knowledge base, so **never commit them**.

**3.2 Get `teamId`**

`teamId` is the team identifier, e.g. `1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`. You can find it in the team settings of the Lexiang web app. With it, the next command resolves the knowledge-base coordinates for you.

**3.3 Get `spaceId` and `rootEntryId` with one command**

Put `teamId` into `config.js`, then run:

```bash
node tools/lexiang-check.js --spaces
```

Output looks like:

```
共 1 个知识库：

  示例知识库                spaceId     = 0f1e2d3c4b5a69788796a5b4c3d2e1f0
                    rootEntryId = 9f8e7d6c5b4a39281706f5e4d3c2b1a0
```

Fill both values into `spaceId` and `rootEntryId` in `config.js`. You can also pass the team id directly: `node tools/lexiang-check.js --spaces <teamId>`.

> If that endpoint is unavailable on your account tier, do it manually: open the knowledge base in the Lexiang web app, press F12 → Network, and read the `space_id` query parameter on any `/kb/` request. Resolve `rootEntryId` with `--list` in the next step.

**3.4 Create the grade folder (subject folders are optional)**

Create a folder named after the grade inside the knowledge base, e.g. `四年级` (Grade 4).

- Grade 4: put its id into `grade4EntryId`
- Other grades: leave it empty — the code looks up a folder with the same name as the grade selected at login (if not found it falls back to the root and logs a `未找到年级目录` warning)

**Subject folders (wrong answers / study memory / question bank) are created automatically** on first archive under the grade folder. If you prefer fixed ids, create them by hand and fill in `subjects`.

**3.5 Two optional pages (the related features are unavailable without them)**

- The "Identity and habits" page → `identityEntryId`
- The "Session records" folder → `sessionEntryId`

**3.6 Verify**

```bash
node tools/lexiang-check.js
```

Continue only when everything shows `[ OK ]` and the conclusion says the credentials and coordinates are all usable. This step saves roughly 80% of later debugging.

### Step 4 — Deploy the API proxy

#### Why a proxy is required

WeChat Mini Programs cannot set a custom User-Agent on a real device, and the Lexiang WAF blocks mobile UAs with a 404. Server-side forwarding is therefore required. Inside DevTools a desktop UA is used and direct access works — so "works in DevTools, blank on device" is expected behaviour, not a bug.

Pick one of three channels:

| Channel | Code | Configuration | When to use |
| --- | --- | --- | --- |
| WeChat Cloud Function | `cloudfunctions/lexiang-proxy` | `CLOUD_ENV_ID` | **Recommended** — no domain filing, calls are authenticated by WeChat |
| Tencent Cloud SCF | `cloudfunctions/scf-lexiang-proxy` | `LEXIANG_PROXY_URL` + `LEXIANG_PROXY_KEY` | Fast in mainland China, free tier |
| Cloudflare Workers | `cloudflare-worker.js` | same as above | You already have a Cloudflare account |

All three speak the same protocol (`{action: 'token' | 'request'}`) and read credentials from the environment variables `LX_APP_KEY` / `LX_APP_SECRET` / `LX_STAFF_ID`.

The two public-internet options also need a caller-verification key. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

#### Option A — WeChat Cloud Function (recommended)

1. In DevTools open "Cloud Development" → create an environment (pay-as-you-go; personal testing stays within the free tier)
2. Copy the environment id (e.g. `cloud1-xxxxxxxx`) into `CLOUD_ENV_ID` in `config.js`
3. Right-click `cloudfunctions/lexiang-proxy` → "Upload and deploy: install dependencies in the cloud"
4. Cloud console → Functions → `lexiang-proxy` → Config → Environment variables: add `LX_APP_KEY`, `LX_APP_SECRET`, `LX_STAFF_ID`
5. Redeploy after changing environment variables, then send `{"action":"token"}` from the function's "Test" tab — a token means it works

Cloud Functions are authenticated by WeChat's call chain, so only users of your Mini Program can invoke them — `LX_PROXY_KEY` is **not** needed here. If you open it to other users, add an `OPENID` allowlist.

#### Option B — Tencent Cloud SCF

1. Open the [SCF console](https://console.cloud.tencent.com/scf) → create a function → "Start from scratch"
2. Runtime: Node.js 16 or 18. **Set the timeout to 20 seconds** (the 3-second default is not enough to archive a page of wrong answers)
3. Paste the whole of `cloudfunctions/scf-lexiang-proxy/index.js` into the online editor → deploy
4. Function config → Environment variables: add `LX_APP_KEY`, `LX_APP_SECRET`, `LX_STAFF_ID`, and `LX_PROXY_KEY` (the value generated above)
5. Function management → Function URL → enable it. **Choose "No authentication"**: `wx.request` cannot sign requests to a function URL, so enabling authentication breaks the call. Security is provided by `LX_PROXY_KEY`
6. Copy the function URL (e.g. `https://xxx-xxxx.gz.tencentcs.com/release/`) into `config.js` as `LEXIANG_PROXY_URL`, and put the same key into `LEXIANG_PROXY_KEY`
7. Self-test with curl (use your own URL and key) — `{"success":true,...}` means it works:

   ```bash
   curl -X POST "https://xxx-xxxx.gz.tencentcs.com/release/" \
     -H "Content-Type: application/json" \
     -H "x-proxy-key: your-key" \
     -d '{"action":"token"}'
   ```

If `LX_PROXY_KEY` is not set, the function **rejects every request**. That is a deliberate secure default: better to be closed than to leave a public function URL unguarded.

#### Option C — Cloudflare Workers

1. Sign up for Cloudflare → Workers & Pages → create a Worker
2. Paste `cloudflare-worker.js` → deploy
3. Settings → Variables and Secrets: add `LX_APP_KEY`, `LX_APP_SECRET`, `LX_STAFF_ID`, `LX_PROXY_KEY` (use encrypted secrets)
4. Copy the Worker URL (e.g. `https://xxx.workers.dev`) into `LEXIANG_PROXY_URL`, and the same key into `LEXIANG_PROXY_KEY`

### Step 5 — Fill in config.js

| Field | Option A | Option B/C |
| --- | --- | --- |
| `CLOUD_ENV_ID` | required | leave empty |
| `LEXIANG_PROXY_URL` | leave empty | required |
| `LEXIANG_PROXY_KEY` | leave empty | required |
| `LEXIANG.appKey` / `staffId` / `spaceId` / `rootEntryId` | required | required |
| `LEXIANG.appSecret` | **leave empty** | **leave empty** |
| `PRESET_ACCOUNTS` | set your own account | set your own account |

With `appSecret` empty the client never talks to Lexiang directly — credentials exist only on the server. That is the recommended posture.

### Step 6 — Configure request domains

Required for a production build, otherwise every network request from a real device is blocked:

- **Proxy domain**: the host of `LEXIANG_PROXY_URL` (`*.gz.tencentcs.com` for SCF, `*.workers.dev` for Cloudflare)
- **LLM domains**: model requests are made **directly by the client**, not through the proxy, so every provider domain must be listed. Common ones:
  `api.deepseek.com`, `dashscope.aliyuncs.com`, `api.moonshot.cn`, `ark.cn-beijing.volces.com`, `open.bigmodel.cn`, `api.siliconflow.cn`, `api.hunyuan.cloud.tencent.com`, `aip.baidubce.com`, `token.sensenova.cn`, `api.stepfun.com`

Where: WeChat Official Accounts Platform → Development → Development settings → Server domains → request domains.

In DevTools you can tick "Do not verify request domains" to get things running, **but that switch has no effect in an uploaded release**.

### Step 7 — Verify in three stages

| Stage | What to do | Pass criteria |
| --- | --- | --- |
| 1 Desktop | `node tools/lexiang-check.js` | everything `[ OK ]` |
| 2 DevTools | Compile → add a model connection on the settings page (enter the key) → capture one wrong answer | Console shows `[lexiang] 传输方式切换为: cloud / http`, and the item appears in the right Lexiang folder |
| 3 Device | Tap "Preview", scan the QR code, repeat stage 2 | Same as above. If only this stage fails, the proxy is the problem |

### Step 8 — Release

1. DevTools → Upload → version number and notes
2. WeChat Official Accounts Platform → Version management → submit for review
3. Publish once approved

Note: login verifies against `PRESET_ACCOUNTS` in `config.js` **on the client side**, so the account and password ship inside the package. Before letting anyone else use it, move that check to the server.

## Configuration reference

| Field | Required | Meaning / where it comes from |
| --- | --- | --- |
| `CLOUD_ENV_ID` | Option A | Cloud Development environment id (console → Environment settings) |
| `LEXIANG_PROXY_URL` | Option B/C | Public proxy URL |
| `LEXIANG_PROXY_KEY` | Option B/C | Must equal the server-side `LX_PROXY_KEY` |
| `LEXIANG.appKey` | Yes | Lexiang open-platform app |
| `LEXIANG.appSecret` | Leave empty | If filled it is bundled into the Mini Program and can be extracted |
| `LEXIANG.staffId` | Yes | Lexiang member account, sent as `x-staff-id` |
| `LEXIANG.spaceId` | Yes | Knowledge-base id; `--spaces` resolves it |
| `LEXIANG.rootEntryId` | Yes | Knowledge-base root node; `--spaces` resolves it |
| `LEXIANG.teamId` | No | Not used at runtime; only for `--spaces` lookup |
| `LEXIANG.identityEntryId` | No | "Identity and habits" page |
| `LEXIANG.sessionEntryId` | No | "Session records" folder |
| `LEXIANG.grade4EntryId` | No | The "四年级" folder |
| `LEXIANG.subjects.*` | No | Created automatically at runtime when empty |
| `PRESET_ACCOUNTS` | Yes | Login account — change it to your own |

## Troubleshooting

| Symptom / error | Cause | Fix |
| --- | --- | --- |
| `未授权：缺少或错误的 x-proxy-key` | Keys differ on the two sides | Make `LEXIANG_PROXY_KEY` in `config.js` equal `LX_PROXY_KEY` on the server |
| `服务端未配置 LX_PROXY_KEY，出于安全已拒绝所有请求` | SCF has no such variable | Add it under Function config → Environment variables, then redeploy |
| `缺少 LX_PROXY_KEY：请为该 Worker 配置调用方校验密钥` | Worker missing the variable | Add it under Settings → Variables and Secrets |
| `未配置可用代理（请填写 CLOUD_ENV_ID…）` | Neither channel configured | Back to step 4 |
| `token 获取失败（HTTP 401/403）` | Wrong appKey / appSecret, or credentials were rotated | Re-check on the open platform |
| `创建科目「X」失败` | Wrong spaceId, app lacks access to that knowledge base, or `staffId` is empty | Re-run `lexiang-check.js` |
| Device reports `直连被拦截（404）` | WAF blocking the mobile UA | Expected — configure a proxy |
| Works in DevTools, blank on device | No proxy, or domains not whitelisted | Steps 4 and 6 |
| Images do not render | `assets/` missing | Re-clone the full directory |

## Security notes (please read)

- `utils/config.js` **is git-ignored** because it holds real credentials. Commit only `config.example.js`
- A Mini Program `appSecret` equals full read/write access to your knowledge base. **Leave it empty** and supply it through cloud-function environment variables (when empty, `lexiang.js` automatically uses the cloud/proxy channel)
- Once a credential enters Git history it is compromised. Deleting the file does not help; it must be reissued on the open platform
- **Public proxies (SCF function URL, Cloudflare Worker) must set `LX_PROXY_KEY`.** Without it this repository's code rejects every request; if you strip that check, anyone with the URL can mint a token and read or write your knowledge base
- Cloud Functions are authenticated by WeChat, but users of the same AppID can still invoke them; add an `OPENID` allowlist before multi-user use
- `utils/crypto.js` is reversible obfuscation (XOR), **not encryption**. It only keeps cached keys from appearing in plaintext; do not treat it as a security boundary

## Asset licensing

The illustrations and badges under `assets/` are AI-generated and are **not covered by the MIT license**. Do not use them commercially. The source code is MIT-licensed; see [LICENSE](./LICENSE).

## Disclaimer

A personal learning project, unaffiliated with Lexiang. When using it, comply with the Lexiang open-platform terms of service and the WeChat Mini Program operating rules.
