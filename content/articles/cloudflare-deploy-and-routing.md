---
title: "部署、版本与回滚：渐进发布、路由与自定义域名"
description: 讲清 wrangler deploy 背后的版本与部署两个概念、渐进发布与回滚能回滚什么不能回滚什么，workers.dev、routes 与 custom domains 的区别，静态资源 assets 的部署形态，以及常见的部署坑。
date: 2026-10-22
tags: [cloudflare, tutorial, workers]
category: cloudflare
chapter: 4
---

> 限额与行为以 2026-10 官方文档为准，会变化。**线上部署、渐进发布、回滚、路由与域名的行为都没有实测**（本文不使用任何 Cloudflare 账号，也不执行 `wrangler deploy` 等会改动线上资源的命令），除非特别说明，均来自官方文档。标注「本地实测」的部分用 wrangler 4.151.3 的 `--dry-run` 与 `wrangler dev --local` 验证过。

## 问题：「发布」其实是两件事

朴素的发布是：构建、上传、立刻 100% 生效。出了问题再发一个修复版本。这在小站点上够用，但它把两件事绑在了一起：**把代码放到平台上**，和**让流量走到这份代码**。一旦想「先上去看看，只放 5% 流量」，或者想「立刻回到昨天的版本」，就需要把这两件事拆开。

Workers 的模型正是拆开的：

- **版本（version）**：每次修改代码或配置都会产生一个版本，它是 Worker 在某一时刻完整状态的快照，包含打包后的代码、静态资源、绑定和兼容性设置，有唯一 ID，记录谁在何时从哪里创建，可选附带消息与标签（官方文档）。
- **部署（deployment）**：决定哪些版本接收流量。官方概览页的说法是：一个部署可以引用一个版本（承接 100% 流量），或在渐进发布期间引用两个版本并在它们之间分流（官方文档）。

`wrangler deploy` 是两步合一：创建版本，并立刻把 100% 流量给它。想拆开，就用 `wrangler versions upload`（只创建版本）和 `wrangler versions deploy`（设置流量分配）。

## 部署流程与渐进发布

最小的上线流程：

```bash
npx wrangler deploy --dry-run --outdir out   # 只编译，不上传，可在 CI 里先跑
npx wrangler deploy --env production         # 显式指定环境
```

本地实测：`--dry-run` 会完整读取配置、打包代码、枚举静态资源并列出绑定清单，然后退出，不触碰线上。它是检验「这份配置能不能打包」最便宜的办法。

渐进发布（gradual deployment）把流量切换变成可观察的过程：

```bash
npx wrangler versions upload --tag v42 --message "fix checkout"
npx wrangler versions deploy <新版本ID>@10 <旧版本ID>@90
# 观察错误率与日志后再次执行，把新版本调到 100%
```

按官方文档（未实测）：

- 你给每个版本指定百分比，**每个请求独立按比例路由**。一个部署最多引用两个版本，这一点出自官方版本与部署概览页（「one version … or two versions」）；渐进发布页的示例和 dashboard 的说法也都是「两个版本之间分流」。另外，只能用你最近上传的 100 个版本创建渐进发布。
- 默认情况下，同一个用户的连续请求可能落到不同版本。需要把用户固定在同一版本时，用版本亲和性（version affinity）。
- 版本偏差（version skew）是真实风险：前端、Worker 和通过 service binding 调用的其他 Worker 可能在同一时刻跑着不同版本。接口只加不改、先发后端再发前端，这类老办法在这里依然适用。官方还提供 version overrides，用于在子请求里把下游 Worker 固定到指定版本。
- Durable Objects 的规则不同：每个 Durable Object 同一时刻只会运行一个版本，要应用待处理的 DO 迁移需要用 `wrangler deploy`（官方文档）。DO 的详细模型见 [Durable Objects：单线程模型](/articles/cloudflare-durable-objects-model)。
- 版本里可以通过 version metadata 绑定读到版本 ID 与标签，用来在日志和错误上报里标记「这条请求跑的是哪个版本」。

渐进发布的价值取决于你是否真的在看指标。没有按版本区分的错误率观测，分流只是把事故拉长。流量很小的服务，5% 可能一小时也碰不到几个请求，直接全量加快速回滚反而更实际。

## 回滚：回的是代码，不是世界

`wrangler rollback [版本ID]` 或 dashboard 上的 Rollback，把 100% 流量路由到你选定的旧版本；如果当前是分流部署，回滚会把分流替换为单个版本 100%，等于把其中一个版本「提升」为全量（官方文档，未实测）。

关键是官方文档写明的限制：

- **绑定指向的资源不会被回滚**。KV、R2、D1、Durable Objects 里的数据变更不属于版本。代码回到旧版本，数据结构却已经是新的，旧代码可能直接报错。所以数据库迁移要写成向前兼容：先加列，再发代码，最后才删旧列。
- 如果当前部署与目标版本之间发生过 Durable Object 类的生命周期变更（通过 `exports` 配置或旧的 `migrations` 数组），回滚会被阻止；如果目标版本绑定的 R2 桶、KV 命名空间或队列已经不存在，回滚同样被阻止。官方还写到，若 KV、D1 等平台资源在两个版本之间被删除或修改，也不能回滚，并把上述两种情形列为「具体来说」的禁止条件。
- 只能回滚到最近发布的 100 个版本；interactive 模式可从最近 100 个里选，也可以直接在命令行给版本 ID（官方回滚页）。关于列出版本的数量，官方有两处说法：`wrangler versions list` 的命令参考写的是列出最近 10 个（本地 `wrangler versions list --help` 也写 "List the 10 most recent Versions"，已实测），而版本与部署概览页写 Wrangler 可以查看最近 100 个版本与部署。我无法在不登录的情况下实际运行该命令，所以不对实际输出下结论；写脚本时别假设它会把所有可回滚的版本都列出来，需要特定版本时直接用版本 ID 或标签。
- 官方回滚页没有提到 secrets 的影响。另一方面，官方 secrets 页说 `wrangler secret put` 会创建新版本并立即部署，而版本的定义包含绑定与配置，所以不要想当然地认为回滚「不动 secrets」或「会还原 secrets」，把 secret 轮换当作需要单独验证的操作（官方文档，未实测）。

结论：回滚是止血手段，不是撤销按钮。**会改变数据形状的变更，必须先设计好「旧代码能读新数据」。**

## 入口：workers.dev、routes 与 custom domains

Worker 部署后需要一个被访问的入口，有三种（官方文档，未实测）：

- **workers.dev**：每个 Worker 自动有一个 `workers.dev` 子域名，可以关闭。适合起步和内部测试；官方建议生产环境用 Route 或 Custom Domain，而不是 workers.dev。
- **Custom Domains**：把一个域名或子域名直接指给 Worker，**Worker 就是这个主机名的源站**。Cloudflare 自动创建 DNS 记录和证书。要求域名所在的 zone 在 Cloudflare，且该主机名上没有已存在的 CNAME。只按主机名匹配，不支持通配，路径和查询参数被忽略。
- **Routes**：按 URL 模式（如 `example.com/api/*`）匹配 zone 内的请求，Worker 位于**已有源站之前**。需要自己管理一条已代理（proxied）的 DNS 记录，否则请求会解析失败。模式里 `*` 是唯一的通配符，不允许中缀通配，最具体的模式优先。

```jsonc
{
  "routes": [
    { "pattern": "shop.example.com", "custom_domain": true },
    { "pattern": "example.com/api/*", "zone_name": "example.com" }
  ]
}
```

怎么选：Worker 就是整个应用（SSR、API、静态站点）时用 Custom Domain，配置最少；Worker 只是挡在老服务前面做鉴权、改写、缓存时用 Route。还有一个容易忽略的差别：同一 zone 内，Worker 之间的 `fetch()` 只有 Custom Domain 可以直接调用，Route 则需要 service binding 才行。另外，Route 如果不绑定任何 Worker，会让匹配的请求绕过 Workers，可以用来给某个子路径「开洞」。

## 静态资源 assets 的部署形态

Workers 现在可以直接托管静态文件。本地实测，下面的配置没有 `main`，只有 `assets`：

```jsonc
{
  "name": "site",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./public", "not_found_handling": "404-page" }
}
```

`wrangler dev --local` 下，访问 `/` 返回 `public/index.html`，访问不存在的路径返回 `404.html` 且状态码为 404；`wrangler deploy --dry-run` 和 `versions upload --dry-run` 都能识别它。这就是「纯静态站点」形态：没有 Worker 代码，匹配文件直接由平台返回。

如果加上 `main` 和 `binding`，就是「静态资源加动态 Worker」形态：没有匹配文件的请求进入 Worker，Worker 可以自己响应，或者调用 `env.ASSETS.fetch(request)` 回落到静态文件。`run_worker_first` 可以反过来，让指定路径（如 `/api/*`）先走 Worker，支持用 `!` 排除（官方配置页，最多 100 项）。

计费与限额（官方文档，未实测）：命中静态资源的请求免费且不限量，会调用 Worker 脚本的请求按 Workers 计费；限额页写的是每个 Worker 版本最多 20,000 个文件（免费）或 100,000 个（付费），单文件 25 MiB。注意 `run_worker_first` 会让匹配的请求总是调用 Worker，免费额度用尽后这些请求会得到 429，而不是回落到静态文件。静态资源是**版本的一部分**，所以它们和代码一起被回滚。

## 常见部署坑

1. **忘记 `--env`**：配置里有多个环境时，不带参数部署的是顶层环境。本地 `--dry-run` 实测会打印警告。CI 里一律显式传环境。
2. **绑定没在环境里重新声明**：环境不继承绑定，漏写的绑定在运行时才报错，细节见 [wrangler 与绑定](/articles/cloudflare-wrangler-and-bindings)。
3. **dashboard 与配置文件互相覆盖**：`wrangler deploy` 默认用配置覆盖 dashboard 上改过的变量与路由；需要保留变量用 `--keep-vars`。配置文件当唯一事实来源最省事（官方文档，未实测）。
4. **Cron 触发器「注释掉」不等于关闭**：要写 `crons = []` 才会清空（官方配置页）。
5. **Route 没有已代理的 DNS 记录**：请求连不上，表现是域名解析失败，不是 Worker 报错。Custom Domain 没有这个问题，因为 DNS 是自动创建的。
6. **回滚被阻止**：做过 DO 迁移或删除过被绑定的资源后，回滚可能不可用。删除资源之前先确认没有任何可能要回滚到的版本还在引用它。
7. **把 workers.dev 当生产入口**：官方定位是起步与个人项目用。

## 小结

版本是快照，部署是流量分配；把两者分开才有渐进发布与快速回滚。回滚只回代码和静态资源，不回数据，所以数据变更要向前兼容。入口选择上，Worker 是源站用 Custom Domain，Worker 在老源站前面用 Route，workers.dev 只用来起步。静态资源是版本的一部分，既可以单独成站，也可以和 Worker 组合。

## 延伸阅读

- [wrangler 与绑定：配置文件、本地开发与线上的差异、环境与 secrets](/articles/cloudflare-wrangler-and-bindings)
- [Workers 到底是什么：isolate、不是 Node、没有常驻进程](/articles/cloudflare-workers-model)
- [请求生命周期：fetch、ctx.waitUntil，以及 CPU 时间与墙钟时间](/articles/cloudflare-request-lifecycle)
- [Cloudflare 存储怎么选](/articles/cloudflare-storage-decision-tree)
- [版本与部署（官方）](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)
- [渐进发布（官方）](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/)
- [回滚（官方）](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
- [Routes 与 Custom Domains（官方）](https://developers.cloudflare.com/workers/configuration/routing/)
- [静态资源（官方）](https://developers.cloudflare.com/workers/static-assets/)
- [Workers 限制（官方）](https://developers.cloudflare.com/workers/platform/limits/)
