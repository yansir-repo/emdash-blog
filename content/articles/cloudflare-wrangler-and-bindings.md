---
title: "wrangler 与绑定：配置文件、本地开发与线上的差异、环境与 secrets"
description: 讲清 wrangler.jsonc 的核心字段、为什么绑定（binding）是 Workers 的核心抽象，以及 wrangler dev 本地模拟与线上的差异、vars 与 secrets 的区别、.dev.vars 优先级、类型生成和多环境的坑。
date: 2026-10-22
tags: [cloudflare, tutorial, workers]
category: cloudflare
chapter: 3
---

> 限额与行为以 2026-10 官方文档为准，会变化。标注「本地实测」的内容在 wrangler 4.151.3（workerd 2026-10-19）的 `wrangler dev --local` 上跑过；标注「来自官方文档，未实测」的内容没有复现。本文没有执行任何会改动线上资源的命令。

## 问题：代码怎么拿到「数据库」

传统后端拿外部资源的方式是连接串：环境变量里放 `DATABASE_URL`，代码里 `new Client(url)`。这个模型有三个麻烦：连接串本身是密钥，泄漏就等于权限泄漏；开发、测试、生产要换一串字符串，但代码拿到的东西形状没变，没人检查你连的是不是对的库；运行时要自己管连接池、重试、认证。

Workers 换了一种抽象：**绑定（binding）**。你在配置文件里声明「这个 Worker 需要一个叫 `CACHE` 的 KV 命名空间」，平台在运行时把一个已经授权好的对象放进 `env.CACHE`。代码拿到的是**能力（capability）**，不是地址加凭据：能调用 `put/get`，仅此而已。

这带来两个后果。第一，代码里没有可泄漏的连接串，权限边界等于「配置里声明了哪些绑定」。第二，同一份代码换一份绑定声明就能指向另一个资源，这正是本地开发和多环境能成立的基础。后面所有内容都围绕这条主线展开。

## wrangler.jsonc 的骨架

wrangler 是 Cloudflare 的命令行工具，也是配置文件的解释者。官方推荐用 `wrangler.jsonc`（本文统一用它）。最小骨架如下：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "demo",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "GREETING": "from-config" },
  "kv_namespaces": [{ "binding": "CACHE", "id": "<KV_ID>" }]
}
```

- `name`：Worker 的名字，只能是字母数字和连字符，不能有下划线（官方文档）。它同时决定部署后的 Worker 标识和环境的命名（见下文）。
- `main`：入口文件。纯静态资源的 Worker 可以省略（官方文档，未实测）。
- `compatibility_date`：声明「我按哪一天的运行时行为来写代码」。平台不会因为升级运行时而悄悄改变你已部署代码的行为，行为变更都挂在日期后面。新项目写当天或接近当天的日期，旧项目不要随手抬高，抬高就等于一次需要回归测试的升级。
- `compatibility_flags`：在日期之外单独打开某个特性，常见的是 `nodejs_compat`，让一部分 Node 内置模块可用。官方说明兼容性日期 2026-08-04 或更晚时它默认开启，新配置可以省略；上面的骨架里写着它，是为了让示例对更早的日期也成立（细节见 [Workers 到底是什么](/articles/cloudflare-workers-model)）。

绑定是配置里剩下的大部分内容：`kv_namespaces`、`d1_databases`、`r2_buckets`、`durable_objects`、`queues`、`services`、`assets` 等。字段名对应产品，`binding` 字段决定它在 `env` 上的属性名。

## 类型生成：让 env 不再是 any

绑定声明在配置里，类型在代码里，两份信息如果靠手写同步，迟早漂移。`wrangler types` 的做法是让配置成为唯一来源：

```bash
npx wrangler types
npx wrangler types --check   # CI 里用：配置变了而类型没重新生成就退出码 1
```

本地实测：它生成 `worker-configuration.d.ts`，里面既有 `Env` 接口，也有与 `compatibility_date` 和 flags 匹配的运行时类型。几个值得知道的细节：

- `vars` 会被生成成字面量类型，比如 `GREETING?: "from-config"`，而不是 `string`。
- 绑定如果只在部分环境里声明，在默认生成的联合类型里会变成可选属性（`CACHE?: KVNamespace`），这是环境之间配置不一致的直接信号。
- 在配置里修改 `vars` 后，`--check` 立即失败；重新生成后通过。把它放进 CI，等于让「配置与类型一致」成为可检查的不变量。
- 可以用 `--env <name>` 只为某个环境生成类型，用 `--env-interface` 改接口名（官方文档）。

官方 TypeScript 页的建议是用 `wrangler types` 为你的 Worker 生成类型；同时说明 `@cloudflare/workers-types` 仍在 npm 发布，其 5 版本只暴露最新的运行时类型，想让类型与具体兼容性日期和标志匹配，应当用 `wrangler types`（来自官方文档，未实测）。二选一，不要在同一个项目里同时引入两套全局运行时类型，否则很可能出现重复声明（这是推断，未实测）。

## vars 与 secrets：对 Worker 一样，对人不一样

两者在代码里没有区别，都是 `env.X`。区别在于可见性：`vars` 是明文，写在配置文件里，会进 git，在 dashboard 里可见；secret 设置后在 wrangler 和 dashboard 里都不再显示（官方文档）。所以规则很简单：**能公开的配置放 `vars`，任何凭据放 secret**。官方文档明确警告不要把敏感信息放进 `vars`。

secret 用 `wrangler secret put <KEY>` 写入，它会创建新版本并立即部署；想只创建版本不立即生效，用 `wrangler versions secret put`（官方文档，未实测）。官方说明，开启 `nodejs_compat` 并启用 `nodejs_compat_populate_process_env`（兼容性日期 2025-04-01 及以后默认启用）时，`vars` 和 secrets 也会出现在全局 `process.env` 里。本地实测（日期 2026-10-01、未写任何标志）：JSON 对象型的 `vars` 在 `env` 里仍是对象，在 `process.env` 里则是字符串，别混着用。

如果想让「Worker 需要哪些 secret」也成为声明的一部分，配置里有 `secrets.required`：官方说明它在本地开发和 `wrangler deploy`、`wrangler versions upload` 时校验，并作为 `wrangler types` 生成类型的来源。本地实测：配置 `"secrets": { "required": ["API_KEY", "DB_PASSWORD"] }`，`.dev.vars` 里只有 `API_KEY` 和一个未声明的 `EXTRA`，`wrangler types` 生成了这两个必需的 secret 类型而不含 `EXTRA`，`wrangler dev` 启动时警告 `Missing required secrets: DB_PASSWORD`；deploy 时的校验失败行为来自官方文档，未实测。

还有两个限额，来自官方限额页，未实测：每个 Worker 的变量总数（secrets 加文本变量）免费版 64、付费版 128，单个变量大小 5 KB。大块配置不要塞进变量，放 KV 或 R2。

## 本地开发：wrangler dev 到底在跑什么

`wrangler dev` 默认在本机用 Miniflare 和 workerd 跑你的 Worker，所有绑定都由本地模拟（官方文档）。本地资源一开始是空的，不会碰线上数据。本地实测：配置里写的是一个不存在的 KV id `top-kv-id`，`env.CACHE.put/get` 依然正常工作，因为本地模拟不关心这个 id。

这里有三个层级，容易混：

- `wrangler dev`（默认）：Worker 在本地，绑定也是本地模拟。
- 绑定上写 `"remote": true`：Worker 仍在本地，这一个绑定的调用转发到线上真实资源。适合没有完整本地模拟的产品，比如 Workers AI、Vectorize（官方文档，未实测）。注意它会修改真实数据并可能计费，还会增加网络延迟。
- `wrangler dev --remote`：旧模式，代码上传到一个临时预览环境运行，所有绑定都用线上资源，每次保存都要上传（官方文档，未实测）。`--local` 则相反，强制关闭所有 remote 绑定。

官方列出的几个「永远本地」的例外：环境变量、secrets、静态资源始终是本地的；Durable Objects 和 Workflows 始终在本地跑。本地与线上的本质差异在于：本地是单进程模拟，没有跨地区、没有真实的限流与延迟。D1、DO 的 API 形状和事务语义可以本地验证，一致性与性能不行。

### .dev.vars 与 .env 的优先级

本地 secrets 放在与配置文件同目录的 `.dev.vars` 或 `.env`（dotenv 语法，二选一），不要提交 git。本地实测的结果如下，和官方文档一致：

1. 存在 `.dev.vars` 时，同目录的 `.env` 被完全忽略，启动日志写 `Using secrets defined in .dev.vars`。
2. 只有 `.env` 时才读 `.env`。
3. 本地文件里的同名变量**覆盖**配置里的 `vars`：`.dev.vars` 里写 `GREETING=dev-vars-wins`，`env.GREETING` 就是它，而不是配置里的值。
4. `wrangler dev --var GREETING:from-flag` 覆盖配置里的 `vars`；同时存在的 `.dev.vars` 不含该键时，flag 值生效。
5. 指定 `--env staging` 时，如果存在 `.dev.vars.staging`，只读它，`.dev.vars` 不再加载（官方文档，本次实测仅确认了无该文件时回退读 `.dev.vars`）。`.env` 一族则不同：官方说明匹配的 `.env`、`.env.local`、`.env.<环境名>`、`.env.<环境名>.local` 会合并，同名变量取最具体的文件（来自官方文档，未实测）。

推论：同名变量在本地被悄悄覆盖，是「本地正常、线上不对」的常见来源。要么本地文件只放 secret，要么 CI 里检查两者键不重叠。

## 环境：不是继承，是各自声明

`env.<name>` 给同一份代码定义多套配置，用 `--env staging`（或 `CLOUDFLARE_ENV`）选择。每个环境部署成一个**独立的 Worker**，名字是 `<name>-<env>`，比如 `demo-staging`（官方文档，未实测）。

```jsonc
{
  "name": "demo",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "kv_namespaces": [{ "binding": "CACHE", "id": "<PROD_KV_ID>" }],
  "env": {
    "staging": {
      "vars": { "MODE": "staging" },
      "kv_namespaces": [{ "binding": "CACHE", "id": "<STAGING_KV_ID>" }]
    }
  }
}
```

关键规则：`name`、`main`、`compatibility_date`、`routes`、`assets` 等是**可继承**的；`vars`、`kv_namespaces`、`d1_databases`、`durable_objects`、`services`、`queues` 等绑定类字段是**不可继承**的，每个环境必须自己写全（官方文档）。

本地实测印证了这一点：上面的配置如果 `staging` 里不写 `kv_namespaces`，`wrangler dev --env staging` 能正常启动，没有任何报错，直到请求走到 `env.CACHE.put`，才抛出 `Cannot read properties of undefined`。这是个很典型的坑：**漏写的绑定不会在启动时失败，而是在运行时变成 undefined**。配合 `wrangler types`（漏写的绑定在类型里是可选的）和启动时的绑定清单，可以提前发现。

另一个坑：定义了多个环境时，直接 `wrangler deploy` 会部署顶层环境，wrangler 会警告「未指定目标环境」，建议显式传 `--env`，顶层环境用 `--env=""`（本地用 `--dry-run` 实测到该警告）。生产环境不要依赖「不带参数 = 生产」的默认，在 CI 里写死。

## 取舍与误区

- **用环境，还是用多个配置文件**：环境适合「同一份代码、少数几个长期存在的目的地」（dev、staging、prod）。每个分支一套的临时环境不适合，官方的建议是用 Previews（官方文档，未实测）。
- **不要为了「方便」把 secret 放进 `vars`**：它会进 git 历史，之后只能轮换，无法撤回。
- **remote 绑定要节制**：它让本地开发能连真实 Vectorize 之类，但同时让「本地跑一下」有了副作用。读多写少、资源是专用测试库时才打开。
- **dashboard 与配置文件两处改配置**：`wrangler deploy` 默认会用配置文件覆盖 dashboard 里改过的变量，需要保留时用 `--keep-vars`；routes 也会被配置文件覆盖。结论是配置文件应当是唯一事实来源（官方文档，未实测）。
- **compatibility_date 不是越新越好，也不是永远不动**：把它当依赖版本来管理，升级时对照官方的兼容性变更列表。

## 小结

绑定把「连接串」换成「声明过的能力」，配置文件是这份声明的唯一来源，类型、本地模拟、多环境都从它派生。三个值得牢记的事实：本地文件会覆盖 `vars`，环境里的绑定不继承，漏写的绑定在运行时才暴露。下一步看这份配置如何变成线上版本：[部署、版本与回滚](/articles/cloudflare-deploy-and-routing)。

## 延伸阅读

- [Workers 到底是什么：isolate、不是 Node、没有常驻进程](/articles/cloudflare-workers-model)
- [请求生命周期：fetch、ctx.waitUntil，以及 CPU 时间与墙钟时间](/articles/cloudflare-request-lifecycle)
- [Cloudflare 存储怎么选](/articles/cloudflare-storage-decision-tree)
- [Wrangler 配置（官方）](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [环境变量与 secrets（官方）](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [本地开发与远程绑定（官方）](https://developers.cloudflare.com/workers/development-testing/)
- [Wrangler 环境（官方）](https://developers.cloudflare.com/workers/wrangler/environments/)
- [TypeScript 与类型生成（官方）](https://developers.cloudflare.com/workers/languages/typescript/)
