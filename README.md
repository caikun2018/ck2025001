# 错题智练 · Cuoti Zhilian

[English](./README.en.md) | 简体中文

[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![WeChat Mini Program](https://img.shields.io/badge/WeChat-Mini%20Program-07C160.svg)]()
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)]()

> **错题不用再抄了。** 拍一张照，AI 把它整理成结构化错题、归档进知识库、再出几道同类题；连对几次，这道题自动从错题本上消失。

面向小学生的 AI 错题学习闭环微信小程序：**拍照或口述录入错题 → 归档到乐享知识库 → AI 举一反三出题（闯关 / 模拟考试 / 原题练习）→ 连续答对达标自动消退**。

原生微信小程序开发，**无框架、无 npm 依赖、无构建步骤**，导入开发者工具即可运行 —— 这也是它适合当「小程序 + 知识库 + LLM」完整落地参考案例的原因。

## 功能链路

1. **错题录入**：拍照 / 口述 / 手写 / 上传文档，AI 整理成结构化错题（学科、知识点、错因、难度）
2. **归档**：写入乐享知识库，目录按「年级 → 学科 → {错题, 学习记忆, 题库}」分层
3. **出题**：AI 依据错题权重 + 学习记忆薄弱点生成同类题，预生成题库做秒开缓冲
4. **答题**：语音为主、键盘为辅，手写板可直接演算
5. **判题与消退**：连续答对达到阈值即自动消退，并把该知识点从薄弱点移除

## 技术栈

- 微信小程序原生开发（无第三方 UI 库）
- 存储：**乐享知识库**为唯一可信源，本地 `storage` 做缓存加速层
- LLM：任意 OpenAI 兼容接口的模型（`utils/config.example.js` 已内置十余家供应商）
- 文档解析：`utils/fileParser.js` 内置 docx / xlsx / pptx / pdf 解析，DEFLATE 解压依据 RFC 1951 自行实现，不依赖第三方库

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `app.js` / `app.json` / `app.wxss` | 入口、页面注册与全局样式 |
| `pages/` | 13 个页面（登录、AI 助手、错题录入/详情、闯关、练习、成就、设置等） |
| `services/lexiang.js` | 知识库读写与同步（token、目录、错题、学习记忆、题库、进度） |
| `services/llm.js` | 模型调用（含流式与视觉） |
| `services/bank.js` / `progress.js` / `storage.js` / `auth.js` | 题库预热、学习进度、本地缓存、登录 |
| `utils/config.js` | 你的配置（模板为 `config.example.js`，本体不入库） |
| `utils/fileParser.js` / `crypto.js` / `util.js` | 文档解析、本地混淆、通用工具 |
| `cloudfunctions/lexiang-proxy/` | 微信云开发云函数代理（推荐） |
| `cloudfunctions/scf-lexiang-proxy/` | 腾讯云 SCF 代理 |
| `cloudflare-worker.js` | Cloudflare Workers 代理 |
| `tools/lexiang-check.js` | 部署自检脚本：验证凭证与知识库坐标 |
| `assets/` | AI 生成插画（不在 MIT 授权范围内） |

## 部署指南

> 从零到真机跑通约 40~60 分钟。请按顺序执行，**第 3、4 步最容易卡住**。
> 每步末尾都给了可验证的结果，卡住时先查 [排错对照表](#排错对照表)。

### 第 0 步：准备清单

| 需要什么 | 用途 | 是否必须 |
| --- | --- | --- |
| 微信小程序 AppID | 导入项目、真机预览、发布 | 必须（个人主体即可注册） |
| 乐享帐号（**免费版即可**）+ 一组接口凭证 | 错题、学习记忆、题库的唯一存储位置 | 必须 |
| 一个 OpenAI 兼容的 LLM API Key | 出题、讲解、判题 | 必须 |
| API 代理（微信云开发 / 腾讯云 SCF / Cloudflare 三选一） | 绕过乐享 WAF | 真机必须 |
| Node.js ≥ 16 | 跑部署自检脚本、生成密钥 | 建议 |

先说一个容易误判的点：**只在开发者工具里预览时，可以不配代理**（工具内可直连乐享）；**真机一定需要代理**，原因见 [为什么需要代理](#为什么需要代理)。

### 第 1 步：导入项目

1. 微信开发者工具 → 「导入项目」→ 目录选择本仓库根目录
2. **AppID 必须换成你自己的**。仓库内 `project.config.json` 带的是作者 AppID，沿用会导致云开发环境与代码上传都落到别人帐号下。
   - 有自己的 AppID：直接填
   - 没有：点「测试号」。注意**测试号无法使用云开发**，只能走 SCF 或 Cloudflare 通道
3. 不要执行 `npm install` —— 本仓库无 npm 依赖；`package.json` 只存在于云函数目录内，由云端安装

### 第 2 步：生成配置文件

```bash
cp utils/config.example.js utils/config.js
```

`utils/config.js` 已在 `.gitignore` 中，可以放心填真实凭证；仓库里只保留脱敏模板 `config.example.js`。

### 第 3 步：准备乐享知识库（最容易卡住）

这一步要拿到 5 个值：`appKey`、`appSecret`、`teamId`、`spaceId`、`rootEntryId`。

**3.1 创建接口凭证，拿 appKey / appSecret**

> 这个入口**不在独立站点上**，而在乐享管理后台里，找不到是正常的。免费版也能创建。

1. 浏览器打开 `lexiang.tencent.com`，登录**管理员账号**（团队是谁建的，谁就是管理员）
2. 进入**管理后台** → 左侧菜单 **「开发」** → **「接口凭证管理」**
   - 个别版本叫「接口凭证」，或收在「系统管理」下，名字相近的就是它
3. 点 **「添加凭证」**，填个名字（如 `cuoti-app`），确认
4. **初始化成功会弹出 AppSecret —— 它只显示这一次，关掉弹框就再也看不到了**，立刻复制到记事本
5. 同一页面还能看到 **AppKey**，一并复制
6. 点这条凭证的 **「修改权限」**，勾上知识库相关的接口（条目读取 / 创建 / 修改）
7. 检查 **「知识授权范围」**，确认包含你要用的那个知识库（默认是「公司内所有知识」）

> ⚠️ 两个最常见的失败，都发生在这步：
> ① **关掉弹框才想起没复制 AppSecret** —— 页面上不会再显示，只能删掉重建一条；
> ② **建了凭证但没勾接口权限** —— 后面所有调用一律 403，自检脚本会明确报出来。

`appKey` / `appSecret` 等同于知识库的完整读写权，**不要提交到任何仓库**，只填进本地的 `utils/config.js`。

**3.2 拿到 teamId**

`teamId` 是 32 位十六进制，形如 `1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`。

取法：浏览器打开乐享网页端任意团队 / 知识库页面，看地址栏 —— 中间那段 32 位字符通常就是。拿到后下一步一条命令能把知识库坐标全部查出来。

> 实在找不到就跳过这步，用 3.3 兜底方案直接取 `spaceId`，`teamId` 本身在小程序运行时不参与任何逻辑，只是查询工具的参数。

**3.3 一条命令拿到 spaceId 与 rootEntryId**

先把 `teamId` 填进 `config.js`，然后执行：

```bash
node tools/lexiang-check.js --spaces
```

输出形如：

```
共 1 个知识库：

  示例知识库              spaceId     = 0f1e2d3c4b5a69788796a5b4c3d2e1f0
                    rootEntryId = 9f8e7d6c5b4a39281706f5e4d3c2b1a0
```

把这两个值填进 `config.js` 的 `spaceId` 与 `rootEntryId`。也可以直接把 teamId 作为参数传入：`node tools/lexiang-check.js --spaces <teamId>`。

> 如果该接口在你的帐号版本下不可用，改用手动方式：在乐享网页端打开知识库，按 F12 → Network，任一 `/kb/` 请求的 query 里都带 `space_id`；`rootEntryId` 用下一步的 `--list` 查。

**3.4 建年级目录，再用命令取它的 ID**

1. 乐享网页端打开你的知识库，新建一个文件夹，名字就用年级，例如「四年级」
2. 回到终端执行：

   ```bash
   node tools/lexiang-check.js --list
   ```

   它会列出根节点下的所有子项，三列分别是 `类型`、`名称`、`ID`：

   ```
   folder  四年级                   a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
   ```

3. 把「四年级」那一行的 ID 抄进 `config.js` 的 `grade4EntryId`

其他年级不必填。代码会按登录时选的年级名，在根节点下找同名文件夹；找不到会退到根节点并打一条 `未找到年级目录` 警告。

**学科目录（错题 / 学习记忆 / 题库）不需要手工创建** —— 首次归档时小程序会自动在年级目录下建好。想固定下来也可以手工建，再填进 `subjects`。

**3.5 两个可选页（不建则对应功能不可用）**

- 「身份和习惯」页面 → 填 `identityEntryId`
- 「会话记录」文件夹 → 填 `sessionEntryId`

取法同上：在知识库里建好，然后 `node tools/lexiang-check.js --list <年级目录的ID>` 列出该层子项，抄 ID。这只是两个可选功能，第一次跑通可以先跳过。

**3.6 验证**

```bash
node tools/lexiang-check.js
```

全部 `[ OK ]`、结论为「凭证与知识库坐标全部可用」才继续。这一步能省掉后面 80% 的调试时间。

### 第 4 步：部署 API 代理

#### 为什么需要代理

微信小程序真机无法自定义 User-Agent，乐享 WAF 会拦截移动端 UA 返回 404，因此真机请求需服务端转发。开发者工具带桌面 UA 可直连 —— 所以「工具里正常、真机白屏」是正常现象，不是代码 bug。

三种通道任选其一：

| 通道 | 代码位置 | 需要配置 | 适用场景 |
| --- | --- | --- | --- |
| 微信云函数 | `cloudfunctions/lexiang-proxy` | `CLOUD_ENV_ID` | **推荐**，不用域名备案，调用天然带微信侧鉴权 |
| 腾讯云 SCF | `cloudfunctions/scf-lexiang-proxy` | `LEXIANG_PROXY_URL` + `LEXIANG_PROXY_KEY` | 国内访问快、有免费额度 |
| Cloudflare Workers | `cloudflare-worker.js` | 同上 | 已有 Cloudflare 帐号 |

三者协议一致（`{action: 'token' | 'request'}`），凭证统一通过环境变量 `LX_APP_KEY` / `LX_APP_SECRET` / `LX_STAFF_ID` 提供。

两个公网方案还需要一个调用方校验密钥，先生成：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

#### 方案 A：微信云函数（推荐）

1. 开发者工具左侧「云开发」→ 开通环境（按量付费，个人测试基本在免费额度内）
2. 复制环境 ID（形如 `cloud1-xxxxxxxx`）→ 填进 `config.js` 的 `CLOUD_ENV_ID`
3. 右键 `cloudfunctions/lexiang-proxy` → 「上传并部署：云端安装依赖」
4. 云开发控制台 → 云函数 → `lexiang-proxy` → 配置 → 环境变量，添加 `LX_APP_KEY`、`LX_APP_SECRET`、`LX_STAFF_ID`
5. 改完环境变量后重新部署一次，在云函数「测试」页发 `{"action":"token"}`，能返回 token 即通

云函数由微信调用链鉴权，只有你这个小程序的用户能调到，因此**不需要** `LX_PROXY_KEY`。若打算开放给他人使用，建议再加 `OPENID` 白名单。

#### 方案 B：腾讯云 SCF

1. 登录 [SCF 控制台](https://console.cloud.tencent.com/scf) → 新建云函数 → 「从头开始」
2. 运行环境 Node.js 16 或 18；**超时时间改为 20 秒**（默认 3 秒不够归档一页错题）
3. 把 `cloudfunctions/scf-lexiang-proxy/index.js` 全文粘贴进在线编辑器 → 部署
4. 函数配置 → 环境变量，添加四个：`LX_APP_KEY`、`LX_APP_SECRET`、`LX_STAFF_ID`、`LX_PROXY_KEY`（上一步生成的值）
5. 函数管理 → 函数 URL → 开启。**认证类型选「无认证」**：小程序 `wx.request` 无法对函数 URL 做签名认证，开着反而调不通，安全性由 `LX_PROXY_KEY` 承担
6. 复制函数 URL（形如 `https://xxx-xxxx.gz.tencentcs.com/release/`），填进 `config.js`：`LEXIANG_PROXY_URL` 填该 URL，`LEXIANG_PROXY_KEY` 填同一个密钥
7. 用 curl 自测（换成你的 URL 与密钥），返回 `{"success":true,...}` 即通：

   ```bash
   curl -X POST "https://xxx-xxxx.gz.tencentcs.com/release/" \
     -H "Content-Type: application/json" \
     -H "x-proxy-key: 你的密钥" \
     -d '{"action":"token"}'
   ```

`LX_PROXY_KEY` 未配置时该函数**拒绝所有请求**，这是刻意的安全默认值：宁可关死，也不让函数 URL 裸奔在公网上。

#### 方案 C：Cloudflare Workers

1. 注册 Cloudflare → Workers & Pages → 创建 Worker
2. 粘贴 `cloudflare-worker.js` → 部署
3. Settings → Variables and Secrets，添加 `LX_APP_KEY`、`LX_APP_SECRET`、`LX_STAFF_ID`、`LX_PROXY_KEY`（建议都用加密类型）
4. 复制 Worker URL（形如 `https://xxx.workers.dev`）→ 填进 `LEXIANG_PROXY_URL`，同一密钥填进 `LEXIANG_PROXY_KEY`

### 第 5 步：回填 config.js

对照下表把值填全，字段含义见 [配置字段参考](#配置字段参考)：

| 字段 | 方案 A | 方案 B/C |
| --- | --- | --- |
| `CLOUD_ENV_ID` | 必填 | 留空 |
| `LEXIANG_PROXY_URL` | 留空 | 必填 |
| `LEXIANG_PROXY_KEY` | 留空 | 必填 |
| `LEXIANG.appKey` / `staffId` / `spaceId` / `rootEntryId` | 必填 | 必填 |
| `LEXIANG.appSecret` | **建议留空** | **建议留空** |
| `PRESET_ACCOUNTS` | 改成自己的账号 | 改成自己的账号 |

`appSecret` 留空时客户端不会直连乐享，只走代理通道，凭证只存在于服务端 —— 这是推荐姿态。

### 第 6 步：配置 request 合法域名

正式版必须配，否则真机所有网络请求都会被拦：

- **代理域名**：`LEXIANG_PROXY_URL` 的域名（SCF 为 `*.gz.tencentcs.com`，Worker 为 `*.workers.dev`）
- **LLM 域名**：模型请求由小程序客户端**直连**、不走代理，因此每家供应商的域名都要加。常用清单：
  `api.deepseek.com`、`dashscope.aliyuncs.com`、`api.moonshot.cn`、`ark.cn-beijing.volces.com`、`open.bigmodel.cn`、`api.siliconflow.cn`、`api.hunyuan.cloud.tencent.com`、`aip.baidubce.com`、`token.sensenova.cn`、`api.stepfun.com`

配置位置：微信公众平台 → 开发管理 → 开发设置 → 服务器域名 → request 合法域名。

开发者工具里可以先勾「不校验合法域名」跑通，**但上传正式版后这个开关无效**。

### 第 7 步：分三段自检

| 阶段 | 做什么 | 通过标准 |
| --- | --- | --- |
| 1 电脑 | `node tools/lexiang-check.js` | 全部 `[ OK ]` |
| 2 开发者工具 | 编译 → 设置页添加模型连接（填 Key）→ 录入一条错题 | 控制台出现 `[lexiang] 传输方式切换为: cloud / http`，错题出现在乐享对应目录 |
| 3 真机 | 点「预览」扫码 → 重复第 2 阶段 | 同上。若只有这一步失败，问题一定出在代理 |

### 第 8 步：发布

1. 开发者工具 → 上传 → 填版本号与备注
2. 微信公众平台 → 版本管理 → 提交审核
3. 审核通过后「发布」

注意：登录走的是 `config.js` 里 `PRESET_ACCOUNTS` 的**本地校验**，账号密码会随包分发。公开给别人用之前，务必改为服务端校验。

## 配置字段参考

| 字段 | 必填 | 说明 / 从哪来 |
| --- | --- | --- |
| `CLOUD_ENV_ID` | 方案 A 必填 | 云开发环境 ID，云开发控制台「环境设置」 |
| `LEXIANG_PROXY_URL` | 方案 B/C 必填 | 代理公网地址 |
| `LEXIANG_PROXY_KEY` | 方案 B/C 必填 | 与服务端环境变量 `LX_PROXY_KEY` 同值 |
| `LEXIANG.appKey` | 必填 | 乐享管理后台「开发 → 接口凭证管理」里创建 |
| `LEXIANG.appSecret` | 建议留空 | 填了会打进小程序包，可被解包还原 |
| `LEXIANG.staffId` | 必填 | 乐享成员帐号，作为 `x-staff-id` 请求头 |
| `LEXIANG.spaceId` | 必填 | 知识库 ID，`--spaces` 可查 |
| `LEXIANG.rootEntryId` | 必填 | 知识库根节点，`--spaces` 可查 |
| `LEXIANG.teamId` | 否 | 小程序运行不使用，仅供 `--spaces` 反查 |
| `LEXIANG.identityEntryId` | 否 | 「身份和习惯」页面 |
| `LEXIANG.sessionEntryId` | 否 | 「会话记录」文件夹 |
| `LEXIANG.grade4EntryId` | 否 | 「四年级」文件夹 |
| `LEXIANG.subjects.*` | 否 | 留空则运行时自动创建 |
| `PRESET_ACCOUNTS` | 必填 | 登录账号，改成你自己的 |

## 排错对照表

| 现象 / 报错 | 原因 | 处理 |
| --- | --- | --- |
| `未授权：缺少或错误的 x-proxy-key` | 两端密钥不一致 | `config.js` 的 `LEXIANG_PROXY_KEY` 与云函数环境变量 `LX_PROXY_KEY` 改为同一个值 |
| `服务端未配置 LX_PROXY_KEY，出于安全已拒绝所有请求` | SCF 未配环境变量 | 函数配置 → 环境变量新增后重新部署 |
| `缺少 LX_PROXY_KEY：请为该 Worker 配置调用方校验密钥` | Worker 未配变量 | Settings → Variables and Secrets 添加 |
| `未配置可用代理（请填写 CLOUD_ENV_ID…）` | 两条通道都没配 | 回到第 4 步 |
| `token 获取失败（HTTP 401/403）` | appKey / appSecret 错、凭证已轮换，**或凭证没勾接口权限** | 回管理后台「接口凭证管理」，点「修改权限」勾上知识库接口 |
| `创建科目「X」失败` | spaceId 错、应用无该知识库权限、`staffId` 为空 | 用 `lexiang-check.js` 复检 |
| 真机报 `直连被拦截（404）` | WAF 拦截移动端 UA | 属正常，配代理即可 |
| 工具里正常、真机白屏 | 未配代理，或域名未加白 | 第 4、6 步 |
| 页面图片空白 | `assets/` 素材缺失 | 从仓库重新拉取完整目录 |

## 安全须知（请务必阅读）

- `utils/config.js` **已在 `.gitignore` 中**，因为里面要填真实凭证。请只提交 `config.example.js`
- 小程序的 `appSecret` 等同知识库完整读写权，**建议留空**，改由云函数环境变量提供（留空时 `lexiang.js` 会自动走云函数/代理通道）
- 凭证一旦进入 Git 历史即视为已泄露，删除文件无效，必须回管理后台删掉那条凭证并重新签发
- **公网代理（SCF 函数 URL、Cloudflare Worker）必须配置 `LX_PROXY_KEY`**。未配置时本仓库的代码会拒绝所有请求；一旦你自行去掉了这道校验，任何人知道地址就能换到 token、进而读写你的知识库
- 微信云函数方案虽由微信侧鉴权，但同 AppID 下的用户仍可调用；多人使用前请加 `OPENID` 白名单
- `utils/crypto.js` 只是可逆混淆（XOR），**不是加密**。它用于避免本地缓存里的 Key 以明文形式出现，请不要当作安全边界

## 素材授权范围

`assets/` 下的卡通插画与徽章为 AI 生成图像，**不属于 MIT 授权范围**，请勿用于商业用途。代码部分采用 MIT 许可，详见 [LICENSE](./LICENSE)。

## 声明

本项目为个人学习用途的开源项目，与乐享官方无关；使用时请遵守乐享开放平台的服务条款与微信小程序的运营规范。
