---
title: Effect 运行时边界与测试：只在入口 run，用 TestClock 测时间
description: Effect 程序只应在入口被运行：Node 用 runMain，长驻服务用 ManagedRuntime，Workers 按请求提供 Layer。再讲 @effect/vitest、TestClock 与内置的 tracing。
date: 2026-10-02
category: effect
tags: [effect, guide, testing]
---

上一篇讲的是 Effect 程序内部的并发与资源。这一篇讲它的外部：一个 `Effect` 值只是一份描述，什么时候、在哪里真正执行它，是整个应用最重要的架构决定之一。

测试部分使用 `@effect/vitest` 与 vitest 5。代码都在 strict 模式下编译通过，测试也实际跑过。

## 不变量：run 只发生在边界

执行只发生在最外层。一旦你在业务代码中间调用 `Effect.runPromise`，就等于主动放弃了中断、依赖注入和 tracing 上下文：新跑的那一段是一棵全新的 Fiber 树，和外层毫无关系。

所以规则很简单：**应用里 `run*` 只出现在入口，数量尽可能趋近于一**。入口在哪取决于宿主：

- 命令行或长驻 Node 进程：`NodeRuntime.runMain`。
- 框架里的多个请求处理函数：启动时构建一个 `ManagedRuntime`，每个请求用它 `runPromise`。
- Cloudflare Workers：在 `fetch` 处理函数里按请求提供 Layer，再 `Effect.runPromise`。

## 先把依赖做成 Layer

边界之内的世界是纯组合的，依赖通过 Layer 提供。服务用 `Context.Service` 定义（前面几篇已用过），不要沿用 v3 的 `Effect.Service` 与 `Layer.scoped` 写法：

```ts
import { Context, Effect, Layer } from "effect"

export class Greeter extends Context.Service<Greeter, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/Greeter") {
  static readonly layer = Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed(`hello ${name}`)
  })
}

class Db extends Context.Service<Db, {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<string>>
}>()("app/Db") {
  static readonly layer = Layer.effect(
    Db,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.log("db open"),
        () => Effect.log("db closed")
      )
      return { query: (_sql: string) => Effect.succeed(["row"]) }
    })
  )
}

export const AppLayer = Layer.mergeAll(Greeter.layer, Db.layer)
```

注意第二个服务：`Layer.effect` 的构造过程里用了 `acquireRelease`，这个资源会挂在 Layer 自己的 Scope 上，Layer 被释放时才关闭。在 v3 里你需要 `Layer.scoped`，v4 里 `Layer.effect` 直接处理了 Scope。资源的生命周期由 Layer 的持有者决定，这正好引出下面的两种入口。

## 入口一：NodeRuntime.runMain

长驻的 Node 进程用 `@effect/platform-node` 的 `runMain`：

```ts
import { Context, Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"

class Greeter extends Context.Service<Greeter, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/Greeter") {
  static readonly layer = Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed(`hello ${name}`)
  })
}

const main = Greeter.use((g) => g.greet("world")).pipe(
  Effect.flatMap(Effect.log),
  Effect.andThen(Effect.never),
  Effect.provide(Greeter.layer)
)

NodeRuntime.runMain(main)
```

`runMain` 接管主 Fiber：捕获 `SIGINT`/`SIGTERM` 并中断它，等 finalizer 全部运行完再退出，并设置退出码。Ctrl+C 之后资源按 LIFO 关闭；不要自己写 `process.on("SIGINT", () => process.exit())`，那会跳过所有 finalizer。

## 入口二：ManagedRuntime

如果宿主是一个别人的框架（Express、Hono、一个 RPC 服务器），主循环不属于你，你只拿到一堆回调。这时用 `ManagedRuntime`：启动时用 Layer 构造一次，之后每个请求复用。

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Greeter extends Context.Service<Greeter, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/Greeter") {
  static readonly layer = Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed(`hello ${name}`)
  })
}

class Db extends Context.Service<Db, {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<string>>
}>()("app/Db") {
  static readonly layer = Layer.effect(
    Db,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.log("db open"),
        () => Effect.log("db closed")
      )
      return { query: (_sql: string) => Effect.succeed(["row"]) }
    })
  )
}

export const runtime = ManagedRuntime.make(
  Layer.mergeAll(Greeter.layer, Db.layer)
)

export const handle = (name: string): Promise<string> =>
  runtime.runPromise(Greeter.use((g) => g.greet(name)))

export const shutdown = () => runtime.dispose()
```

`ManagedRuntime.make` 接受一个不再需要其他依赖的 Layer，返回运行时；`runtime.runPromise` 在这个运行时里执行 Effect；`runtime.dispose()` 释放整个 Layer 持有的资源。我实际运行时的输出是先 `db open`，处理请求，`dispose` 之后 `db closed`，符合预期。

每个请求重新构建 Layer 是坏主意：连接池之类的资源会被反复创建。Layer 构造一次，关闭时机交给 `dispose`。

## 入口三：Cloudflare Workers

Workers 的特点是绑定（binding）来自每次请求的 `env` 参数，而不是进程级全局。所以不要在模块顶层捕获 `env`，而是在 `fetch` 里把它做成 Layer：

```ts
import { Context, Effect, Layer } from "effect"

class Greeter extends Context.Service<Greeter, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/Greeter") {}

interface Env {
  readonly GREETING: string
}

const EnvLayer = (env: Env) =>
  Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed(`${env.GREETING} ${name}`)
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const program = Greeter.use((g) =>
      g.greet(url.searchParams.get("name") ?? "anon")
    ).pipe(
      Effect.map((body) => new Response(body)),
      Effect.withSpan("http.request", {
        attributes: { "http.route": url.pathname }
      })
    )
    return Effect.runPromise(Effect.provide(program, EnvLayer(env)), {
      signal: request.signal
    })
  }
}
```

这里有三个要点。第一，**模块导入期不执行任何有副作用的东西**：不打开连接、不 `Effect.run*`、不读 `env`。顶层只放定义和纯常量。第二，绑定在 handler 内部通过 `Layer.succeed` 进入依赖图，它的生命周期就是这一次请求，不要缓存到全局可变变量里。第三，`runPromise` 的第二个参数可以带 `signal`：请求被客户端取消时，Fiber 会被中断，沿途的 finalizer 和 `Effect.promise` 的 `AbortSignal` 都会触发，和上一篇是同一个机制。

错误要在边界处统一翻译成宿主能理解的形式，比如 HTTP 状态码：

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

declare const find: (id: string) => Effect.Effect<string, NotFound>

export const route = (id: string) =>
  find(id).pipe(
    Effect.map((v) => new Response(v)),
    Effect.catchTag("NotFound", (e) =>
      Effect.succeed(new Response(`no ${e.id}`, { status: 404 }))
    )
  )
```

`catchTag` 之后 `NotFound` 从错误类型里消失了，剩下没处理的错误类型一目了然。边界就是把类型化的失败转成 Response 的地方。

## 测试：用 @effect/vitest

测试 Effect 代码的原则：不要在测试里手写 `Effect.runPromise`，让测试框架把测试体当成 Effect 来跑。`@effect/vitest` 提供了 `it.effect`：

```ts
import { it, expect } from "@effect/vitest"
import { Effect } from "effect"

it.effect("adds", () =>
  Effect.gen(function* () {
    expect(yield* Effect.succeed(1 + 2)).toBe(3)
  })
)
```

`it.effect` 会注入测试用的时钟等服务，并提供 `Scope`：测试里用 `acquireRelease` 获取的资源，会在测试结束时自动释放。需要真实时钟的少数场景用 `it.live`。`it.effect` 本身就带 Scope，通常不需要再用 `it.scoped`。

### TestClock：虚拟时间

`Effect.sleep`、`Effect.timeout`、`Schedule` 在 `it.effect` 里不会真的等待，而是等 `TestClock` 被推进。注意 `TestClock` 要从 `effect/testing` 导入。

```ts
import { it, expect } from "@effect/vitest"
import { Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

it.effect("timeout with virtual time", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.sleep("5 minutes").pipe(
      Effect.timeoutOption("1 minute"),
      Effect.forkChild
    )
    yield* TestClock.adjust("1 minute")
    const result = yield* Fiber.join(fiber)
    expect(result._tag).toBe("None")
  })
)

it.effect("retry backoff", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const task = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (k) => k + 1)
      if (n < 3) return yield* Effect.fail("transient")
      return "ok"
    })
    const fiber = yield* task.pipe(
      Effect.retry(Schedule.exponential("100 millis")),
      Effect.forkChild
    )
    yield* TestClock.adjust("100 millis")
    yield* TestClock.adjust("200 millis")
    expect(yield* Fiber.join(fiber)).toBe("ok")
    expect(yield* Ref.get(attempts)).toBe(3)
  })
)
```

固定套路是 fork、adjust、join。必须先 `forkChild`：`sleep` 会阻塞当前 Fiber，不 fork 的话没有人去推进时钟，测试会死锁。第二个例子里重试的退避间隔是 100ms、200ms，我们按这个节奏推进，整个测试在毫秒内完成。

### 用 Layer 替换依赖

Layer 既是生产的装配方式，也是测试的替换点：

```ts
import { it, expect, describe } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"

class Repo extends Context.Service<Repo, {
  readonly find: (id: number) => Effect.Effect<string, "NotFound">
}>()("test/Repo") {}

const RepoTest = Layer.succeed(Repo, {
  find: (id) => (id === 1 ? Effect.succeed("alice") : Effect.fail("NotFound"))
})

describe("shared layer", () => {
  it.layer(RepoTest)("Repo", (it) => {
    it.effect("finds alice", () =>
      Effect.gen(function* () {
        const repo = yield* Repo
        expect(yield* repo.find(1)).toBe("alice")
      })
    )
    it.effect("fails on 2", () =>
      Effect.gen(function* () {
        const repo = yield* Repo
        expect(yield* Effect.flip(repo.find(2))).toBe("NotFound")
      })
    )
  })
})
```

`it.layer` 让一组测试共享同一个 Layer 实例，回调里的 `it` 已经带上了 Layer 提供的服务。断言失败路径时，`Effect.flip` 把失败和成功互换，于是错误值可以直接 `yield*` 出来比较。也可以用 `Effect.exit` 拿到完整的 `Exit` 做断言。共享 Layer 时不要放可变的 mock 状态。

## 可观测性：简述

Effect 把日志和 tracing 内置在核心里，不需要先装任何包：

```ts
import { Effect } from "effect"

export const traced = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan("order.id", "o1")
  yield* Effect.log("charging")
}).pipe(
  Effect.withSpan("order.charge"),
  Effect.annotateLogs({ tenant: "t1" })
)
```

`Effect.withSpan` 给一段逻辑创建 span，嵌套的 Effect 自动成为子 span；`Effect.annotateCurrentSpan` 往当前 span 上加属性；`Effect.annotateLogs` 给范围内的日志统一加字段。属性命名建议遵循 OpenTelemetry 语义约定，例如 `http.route`。

这些信号默认留在进程内。要导出到 OTLP collector，才需要引入 `@effect/opentelemetry` 并在入口提供 exporter Layer。

## 小结

这一篇的主线只有一句话：**描述与执行分离，执行只发生在边界。**

- Node 进程用 `NodeRuntime.runMain`，它接管信号、等 finalizer、设置退出码。
- 嵌入别人的框架时，用 `ManagedRuntime.make` 构造一次，请求里 `runPromise`，关停时 `dispose`。
- Workers 在 `fetch` 里用请求级的 `env` 构造 Layer，导入期不做任何副作用，并把 `request.signal` 传给 `runPromise`。
- 测试用 `@effect/vitest` 的 `it.effect`，时间用 `TestClock`（来自 `effect/testing`），依赖用 Layer 替换。
- tracing 和日志是内置的，导出才需要 `@effect/opentelemetry`。

v4 要留意的差异：服务用 `Context.Service` 定义，`Layer.effect` 能处理 Scope，`TestClock` 在 `effect/testing`，`it.effect` 已带 Scope。具体 API 以你安装的 `node_modules/effect` 为准，别凭 v3 的记忆写。
