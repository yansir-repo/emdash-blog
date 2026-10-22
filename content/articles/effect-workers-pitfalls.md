---
title: "Effect 跑在 Cloudflare Workers 上：模块级 Runtime 与几个要小心的坑"
description: 讲 Effect 在 Cloudflare Workers 上的实践：模块级 ManagedRuntime、每请求取 context、共享 memo map，避免重复 provide Layer 与跨请求共享状态；并把来自 GitHub issue 的两个已知问题单独标注为未复现。
date: 2026-10-22
category: effect
tags: [effect, advanced]
---

Workers 的执行模型和 Node 服务进程不一样：一个 isolate 会被多个请求复用，但 I/O 对象、timer 又被绑定在发起它的请求上，global scope 里还有额外限制。把 Effect 放进去，真正要想清楚的只有一件事：**哪些东西活在 isolate 级，哪些东西必须活在请求级**。

这篇分成两部分。第一部分是我在本地实际跑过的结论（Layer 构建次数、per-request context）；第二部分是来自 GitHub issue 的已知问题，我没有在 workerd 里复现，会明确标注，不当作确定事实。运行时基础请先看[运行时边界与测试](/articles/effect-runtime-boundaries-and-testing)。

## 验证范围

本文的代码在 `effect@4.0.5`、Node 下用 `tsx` 运行，**没有在 workerd 或 wrangler 里跑过**。所以 Layer 构建次数、context 复用这些属于 Effect 自身的语义，可以确定；凡是涉及 Workers 平台行为的内容，都标明了来源。

## 反模式：在每个 handler 里 provide Layer

`Effect.provide(layer)` 每次运行都会用一个新的 memo map 构建一遍这个 Layer。放在 fetch handler 里，意味着每个请求都重新构建数据库客户端、配置、HTTP 客户端。ManagedRuntime 把构建结果放在模块级，跨请求复用。下面是实测对比：

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

let builds = 0

class Db extends Context.Service<Db, { readonly id: number }>()("app/Db") {
  static readonly layer = Layer.effect(Db, Effect.sync(() => Db.of({ id: ++builds })))
}

const handler = Db.use((db) => Effect.succeed(db.id))

async function main() {
  // 反模式：每个请求 provide 一次，每次都是一个全新的 memo map
  for (let i = 0; i < 3; i++) {
    await Effect.runPromise(handler.pipe(Effect.provide(Db.layer)))
  }
  console.log("per-request provide:", builds)

  // 正确：模块级 ManagedRuntime
  builds = 0
  const runtime = ManagedRuntime.make(Db.layer)
  for (let i = 0; i < 3; i++) await runtime.runPromise(handler)
  console.log("shared runtime:", builds)

  // 两个 runtime 默认各有自己的 memo map；共享 memo map 才能共享构建结果
  builds = 0
  const memoMap = Layer.makeMemoMapUnsafe()
  const r1 = ManagedRuntime.make(Db.layer, { memoMap })
  const r2 = ManagedRuntime.make(Db.layer, { memoMap })
  await r1.runPromise(handler)
  await r2.runPromise(handler)
  console.log("two runtimes, shared memoMap:", builds)
}

void main()
```

输出是 `per-request provide: 3`、`shared runtime: 1`、`two runtimes, shared memoMap: 1`。第三行说明：如果你因为某种原因有多个 runtime，各自默认有独立的 memo map，需要显式传同一个 `memoMap` 才会共享构建结果。

## 推荐形态：模块级 runtime，每请求取 context

核心做法有三点：

1. 模块级 `ManagedRuntime.make(staticLayer)`，只放与请求无关的依赖。
2. 请求相关的数据（`env` 绑定、请求 id、租户）做成 Service，在 fetch 里用 `provideService` 注入。
3. 每个请求调用一次 `runtime.context()` 拿到已构建好的 Context，再用 `provideContext` 提供给请求的 Effect。

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

// 静态依赖：与请求无关，整个 isolate 只构建一次
let dbBuilds = 0

class Db extends Context.Service<Db, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("app/Db") {
  static readonly layer = Layer.effect(
    Db,
    Effect.sync(() => {
      const id = ++dbBuilds
      return Db.of({ query: (sql) => Effect.succeed(`db#${id}: ${sql}`) })
    })
  )
}

// 请求级依赖：env 只能在 fetch 里拿到
class RequestEnv extends Context.Service<RequestEnv, {
  readonly tenant: string
}>()("app/RequestEnv") {}

// 模块级只声明、不构建：make 本身不做 I/O，也不起 timer
const runtime = ManagedRuntime.make(Db.layer)

interface Env {
  readonly TENANT: string
}

const handle = Effect.gen(function*() {
  const env = yield* RequestEnv
  const db = yield* Db
  return new Response(yield* db.query(`select * from ${env.tenant}.users`))
})

const worker = {
  async fetch(_request: Request, env: Env): Promise<Response> {
    // 每个请求取一次 context：首个请求触发构建，之后命中缓存
    const context = await runtime.context()
    return Effect.runPromise(
      handle.pipe(
        Effect.provideContext(context),
        Effect.provideService(RequestEnv, { tenant: env.TENANT })
      )
    )
  }
}

export default worker

// 本地模拟：三个并发请求，租户各不相同
async function main() {
  const bodies = await Promise.all(
    ["a", "b", "c"].map(async (TENANT) =>
      (await worker.fetch(new Request("http://localhost/"), { TENANT })).text()
    )
  )
  console.log(bodies, "dbBuilds =", dbBuilds)
}

void main()
```

实测三个并发请求、租户各不相同，输出里 `db#1` 只出现一个编号，`dbBuilds = 1`：静态 Layer 只构建了一次，请求级的 `RequestEnv` 互不串扰。我还验证了两点：`ManagedRuntime.make` 之后、第一个请求之前，构建次数是 0，也就是说它在 global scope 里只声明、不执行；五个并发的冷启动请求同样只构建一次。

为什么 env 不放进 runtime 的 Layer？因为 `env` 在 Workers 里是 fetch 的参数，按请求传入，global scope 里没有。把它做成请求级 Service，既符合平台模型，也让 Layer 保持纯粹。

### 不要做的事

- 不要在每个 handler 里重复 `Effect.provide(AppLayer)`，上面已经量化过代价。
- 不要把某个请求里创建的 Promise、Fiber、Scope 存进模块级变量给别的请求用。Workers 把 I/O 与发起请求绑定，跨请求使用在平台层面通常会被拒绝或表现异常。这一条是平台约束，**未在本文复现**，我的做法是让这些对象只在请求内创建、请求内结束。
- 不要在 global scope 里做 I/O、起 timer、取随机数。Workers 在全局作用域禁止这类操作（下面 issue 里能看到报错文本 `Disallowed operation called within global scope`）。Effect 的好处是它们都是被描述的 Effect，只要不在模块顶层 `run`，就不会提前执行。
- 需要后台工作时，用 `ctx.waitUntil(runtime.runPromise(...))` 把它挂在请求的生命周期上，而不是 `runFork` 出去就不管。这是 Workers 的通用用法，我没有在 workerd 里验证。

## 来自 issue 的两个已知问题（未在本文复现）

下面两个问题我只是读了 GitHub issue，**没有在 Workers 上复现**，而且 issue 页面显示它们已经被处理，你用的版本可能已经修复，请以你实际使用的版本为准。

### HttpClient 未读取响应的 FinalizationRegistry

issue #9543 报告：在 Workers 上，`HttpClient` 对没有被 scope 管理的响应，会登记到模块级的 `FinalizationRegistry`，被 GC 时回调里执行 `controller.abort()`；这个回调发生在请求上下文之外，于是 Worker 记录一条全局作用域禁止操作的未捕获错误。issue 页面显示它已被 PR #9547 关闭（2026-10-19）。

我能确认的只有一点：我读了 4.0.5 的 `dist/http/HttpClient.js`，里面确实有一个模块级的 `FinalizationRegistry`，回调是 `controller.abort()`。4.0.5 发布于 2026-10-15，早于 #9547，所以 4.0.5 不会包含这个修复；是否在后续版本修复、具体改了什么，我没有验证。规避思路与平台无关：**读取或显式丢弃每一个响应体**，不要让响应对象靠 GC 收场。HttpClient 本身的用法见 [HTTP 那篇](/articles/effect-http)。

### 长寿 fiber

issue #9025 报告：在 Workers 上，一个比发起请求活得更久的长寿 fiber，如果它下一步的调度 timer 属于已结束的请求，就可能挂起；之后等待它的请求也会一起挂住。issue 页面显示它已关闭。我读到的信息是：PR #9032 的方案（改为 microtask 调度）没有合并，另一个文档性质的 PR #9033 合并了，内容是说明 Workers 的限制。具体当前行为我没有验证。

保守的做法不依赖这些修复：在 Workers 上不要让 fiber 的寿命超过单个请求，需要常驻的后台逻辑交给 Durable Objects 或队列，而不是 isolate 里的长寿 fiber。这个建议是推论，未经验证。

## 小结

Effect 在 Workers 上的核心纪律只有一条：isolate 级放静态 Layer（模块级 `ManagedRuntime`，必要时共享 `memoMap`），请求级放 env 与请求数据（每请求 `runtime.context()` 加 `provideService`）。我实测的结论是，重复 provide 的代价是每请求一次构建，而 runtime 方案是一次；`make` 本身不构建，global scope 里是安全的。平台相关的两个问题（HttpClient 的 `FinalizationRegistry`、长寿 fiber）来自 issue，没有在本文复现，可能已被修复，升级前先看对应 issue 的最新状态。
