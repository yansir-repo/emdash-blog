---
title: "Workers 到底是什么：isolate、不是 Node、没有常驻进程"
description: 讲清 Workers 的运行模型：V8 isolate 与容器、Node 服务器的差异，没有常驻进程与可靠全局状态意味着什么，冷启动怎么理解，nodejs_compat 的作用与边界，以及哪些 API 能用。
date: 2026-10-22
tags: [cloudflare, tutorial, workers]
category: cloudflare
chapter: 1
---

> 限额与行为以 2026-10 官方文档为准，会变化。标注「来自官方文档，未实测」的内容没有在本地复现；标注「本地实测」的内容在 wrangler dev（workerd，wrangler 4.151.3）上跑过。本地是单进程模拟，不代表线上的调度、驱逐与冷启动表现。

## 问题：你以为的「服务器」并不存在

后端开发者脑中的部署模型：一个进程常驻在某台机器上，启动时建连接池、读配置，之后每个请求复用这些状态。Workers 的代码长得像一个请求处理函数：

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("hello");
  },
};
```

于是很容易把服务器模型原样套上去：模块顶层放个 Map 当缓存，启动时建数据库连接，用 `fs` 读文件，起个 `setInterval` 做定时任务。这些做法在 Workers 上要么直接报错，要么看起来能跑、某天悄悄出错。理解 Workers 的第一步，是换掉「服务器」这个概念。

## 模型：V8 isolate，而不是进程或容器

按官方文档（来自官方文档，未实测）：Workers 使用 V8 引擎，代码运行在 Cloudflare 全球网络的大量机器上，每台机器的一个运行时实例同时承载成百上千个应用。隔离单位是 **isolate**：V8 的轻量执行上下文，内存彼此独立，在已运行的运行时里创建，不需要为每个函数启动虚拟机或容器。

- **传统服务器 / VM**：机器和进程归你，状态也归你管。
- **容器**：每个实例带完整语言运行时，启动要付进程与运行时初始化的成本，所以有明显冷启动，实例通常会保留一段时间摊薄成本。
- **Workers isolate**：运行时开销由众多租户共同摊薄。官方称 isolate 启动比容器或 VM 里的 Node 进程快「约一百倍」（来自官方文档，未实测，是量级描述，不是 SLA）。

代价来自同一个模型：没有持久的本地磁盘（`node:fs` 只是内存里的虚拟文件系统，见下文）、没有子进程和线程，每个 isolate 内存上限 128 MB（来自官方文档，未实测）。

## 没有常驻进程，意味着什么

官方文档的说法（来自官方文档，未实测）：isolate 不一定长寿，可能因资源压力、疑似逃逸沙箱或触及资源限制被驱逐；一个实例在单线程事件循环上**并发**处理多个请求；请求不保证落到同一实例，所以建议不要依赖或修改全局状态。

拆成三个事实：

1. **全局变量在同一实例的多个请求间共享。** 本地实测：顶层 `let counter = 0` 在 handler 里自增，顺序请求得到 1、2、3；三个并发请求（各 `await` 300ms）看到同一个 `bootId`，计数一起涨到 6。它们在同一个 isolate 里交错执行。
2. **这份共享状态不可靠。** 实例可被驱逐、可能有多个实例，全局变量最多是「可丢失的缓存」，不能当事实来源。
3. **并发不是串行。** 两次 `await` 之间别的请求可能改掉你的状态，和 Node 单进程的并发问题一样，只是在这里更容易被忽视。

### 全局作用域里不能做 I/O

本地实测：在模块顶层调用 `crypto.randomUUID()`，wrangler dev 直接启动失败，报 `Disallowed operation called within global scope`，说明全局作用域不允许异步 I/O、设置定时器和生成随机数，要放进 handler。正确做法是惰性初始化：

```ts
let bootId: string | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    bootId ??= crypto.randomUUID(); // 在 handler 内，允许
    return Response.json({ bootId });
  },
} satisfies ExportedHandler;
```

这里的 `bootId` 是典型的「实例级、可丢失」状态：只用于观察，不参与正确性。需要真正的状态，用存储产品或 Durable Objects，选型见 [存储选型决策树](/articles/cloudflare-storage-decision-tree) 与 [Durable Objects 模型](/articles/cloudflare-durable-objects-model)。

## 冷启动怎么理解

isolate 模型下，冷启动成本主要是「加载并执行你的脚本」，而不是起进程。你能控制的：

- **模块顶层要轻。** 官方限额页给出启动时间上限 1 秒（来自官方文档，未实测）。顶层做大量计算会拖慢每个新实例的首个请求。
- **包体积。** Worker 压缩前大小上限 64 MiB（来自官方文档，未实测），这是上限不是目标。
- **别指望预热。** 实例何时创建、驱逐由平台决定，设计时假设任何请求都可能是某个实例的第一个。

「冷启动很小」不等于可以忽略初始化成本，只是成本从进程启动换成了你自己的脚本执行时间。

## nodejs_compat：作用与边界

大量 npm 包会 `import "node:buffer"`、`node:path`、`node:crypto`。`nodejs_compat` 让一部分 Node API 可用，有的由运行时原生实现，有的是 wrangler 注入的 polyfill。按官方文档（来自官方文档，未实测）：

- 原生支持 Buffer、Crypto、Events、Path、Stream、Timers、URL、Zlib、AsyncLocalStorage 等；Console、DNS、OS、TLS 等是部分支持。
- `child_process`、`worker_threads`、`vm`、`http2`、`readline` 等可以 import 但**不能工作**（non-functional stubs）。
- 兼容性日期 2026-08-04 或更晚时，`nodejs_compat` 与 `nodejs_compat_v2` 默认开启，官方说明这些日期下不再需要写这两个标志，新配置里省略即可，已有项目不必删除；想完全关闭要写 `no_nodejs_compat` 与 `no_nodejs_compat_v2`。
- 兼容性日期在 2024-09-23 至 2026-08-03 之间，需要手动加 `nodejs_compat`；更早的日期要再加 `nodejs_compat_v2` 才是 v2 行为。
- 日期早于 2026-08-04 且没有该标志时，`node:*` 模块整体上不可用；少数能力有独立标志，例如 `nodejs_als` 只开启 `AsyncLocalStorage`。
- 那批「只能 import、不能工作」的 stub 模块（`node:child_process`、`node:worker_threads`、`node:vm`、`node:http2`、`node:readline` 等）按官方说法，是在开启 `nodejs_compat` 且兼容性日期不早于各自的生效日期（2025-09-01 至 2026-03-17 之间）后才会出现。

本地实测（wrangler 4.151.3）：兼容性日期 2026-10-01、不写任何标志，`node:buffer`、`node:path` 正常；`node:child_process` 能 import，但调用 `execSync` 抛出 `ERR_METHOD_NOT_IMPLEMENTED`。能 import 不等于能用。对照实验：兼容性日期 2026-07-01 且不写标志，wrangler dev 启动时提示可能需要 `nodejs_compat`，请求时报 `No such module "node:buffer"`；同一日期加上 `nodejs_compat`，行为与 2026-10-01 相同。所以「不带标志时 node:* 能不能用」取决于兼容性日期，写配置时显式写上 `nodejs_compat` 对新旧日期都成立，只是 2026-08-04 之后多余。

边界：兼容层是为了让库能跑，不是为了让你写 Node 程序，新代码优先用 Web 标准 API（`fetch`、`crypto.subtle`、`URL`、Web Streams）；依赖原生模块、子进程或本地文件的包不会因为开了它而可用；polyfill 会增加包体积。

## 能用与不能用

能用（来自官方文档，未实测）：`fetch`、`Request`/`Response`、`URL`/`URLPattern`、`AbortController`/`AbortSignal`、`TextEncoder`/`TextDecoder`、`atob`/`btoa`、Web Streams、Web Crypto、`EventTarget`，以及请求上下文内的 `setTimeout`/`setInterval`。

不能用或要换思路：

- 本地文件系统持久化：开启 `nodejs_compat` 后 `node:fs` 可用，但官方说明它是内存里的虚拟文件系统，`/bundle` 只读，`/tmp` 可写但内容不持久，且只属于单次请求，其他并发或后续请求看不到（来自官方文档；本地实测写入再读回 `/tmp` 文件正常，未验证跨请求隔离）。持久数据放 R2/KV/D1/DO。
- 子进程、线程、原生扩展：沙箱不允许。
- 常驻后台循环：周期任务用 Cron Trigger，见 [请求生命周期](/articles/cloudflare-request-lifecycle)。
- 用 `Date.now()` 测 CPU 耗时：官方安全模型页说它返回最近一次 I/O 的时间，执行期间不推进（来自官方文档，未在线上实测）。本地实测不一致：wrangler dev 里对同步循环前后各取一次 `Date.now()`，差值约 302 ms，没有被冻结。所以官方描述针对线上运行时，本地结果不能反推线上计时，线上也不要用它度量代码耗时。

## 取舍与常见误区

适合：请求/响应形态、I/O 密集的逻辑，如 API 网关、边缘渲染、鉴权、轻量业务 API，以及主要依赖 Cloudflare 绑定的应用。不适合硬上：重度依赖 Node 专有生态（原生模块、子进程）、长时间占用 CPU 的计算、必须自管长连接进程的系统。此时用容器或传统服务器更诚实，Workers 可以做前面一层。

常见误区：

- 把模块顶层变量当 session 或限流计数器：跨实例不一致，驱逐就丢。
- 以为开了 `nodejs_compat` 就是 Node：它是子集，且有 stub。
- 由本地并发请求能共享变量，推断线上同一用户总命中同一实例：官方明确不保证。
- 在 handler 外起 Promise 不管：见 [请求生命周期](/articles/cloudflare-request-lifecycle)。

## 小结

Workers 是平台调度的 V8 isolate：没有你的进程，全局变量只是同实例内可丢失的缓存，全局作用域不能做 I/O，冷启动成本是脚本加载时间，`nodejs_compat` 是兼容子集。把状态交给存储与 Durable Objects，把计算保持在请求形态里，就是顺着模型而不是对抗它。

## 延伸阅读

- [请求生命周期：fetch、ctx.waitUntil，以及 CPU 时间与墙钟时间](/articles/cloudflare-request-lifecycle)
- [wrangler 与绑定](/articles/cloudflare-wrangler-and-bindings)
- [存储选型决策树](/articles/cloudflare-storage-decision-tree)
- [Durable Objects 模型](/articles/cloudflare-durable-objects-model)
