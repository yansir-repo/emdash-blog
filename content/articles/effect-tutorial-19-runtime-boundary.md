---
title: "运行时边界：ManagedRuntime、与框架接合、Workers"
description: Effect 程序只是描述，总得有人在某个地方真正运行它。本章讲清运行只发生在边缘的含义、为什么长驻进程要构建一个 ManagedRuntime，以及接入 Web 框架和 Cloudflare Workers 时边界该画在哪里。
date: 2026-10-22
tags: [effect, tutorial, runtime, managed-runtime, workers]
category: effect
series: effect-tutorial
seriesOrder: 19
---

前面十八章，我们一直待在 Effect 的内部：组合、错误、依赖、并发、资源。这一章走到边缘，回答一个看似朴素、其实决定整个应用架构的问题：这些描述，到底在哪里、由谁、在什么时候被真正运行？

## 要解决的问题

回忆第 2、3 章：`Effect` 是一个值，是对计算的描述，不运行就什么都不会发生。运行它的函数是 `Effect.runPromise`、`Effect.runFork`、`Effect.runSync` 这一族，统称 `run*`。

现实里，你的 Effect 代码不会孤立存在。它总是被某个宿主调用：一个 CLI 的 `main`，一个 Express 或 Hono 的路由回调，一个 Next.js 的 route handler，一个 Cloudflare Worker 的 `fetch`。宿主不懂 Effect，它只会调用函数、等一个 Promise。于是你必须在宿主和 Effect 之间，放一道把「描述」变成「执行」的门。

问题在于这道门怎么开。开得随意，前十八章积累的所有保证都会在门口漏掉。

## 朴素做法为什么不够

最顺手的做法，是哪里需要结果就在哪里调用 `Effect.runPromise`。比如在一个 service 的方法里，为了把结果交给某个只接受 Promise 的库，就地 run 一下。

这样做有三个后果，都是静默的。

- **中断断开**。第 13 章讲过，fiber 之间有父子关系，父被中断，子跟着被中断。就地 `runPromise` 会启动一棵全新的 fiber 树，和外层没有任何关系。外层被取消了，里面这段还在跑。
- **依赖断开**。第 9、10 章的依赖通过 Layer 提供，是沿着 Effect 的组合结构传下去的。你在中间另起一次运行，那里的环境是空的，得重新 provide 一遍，很容易提供出第二份不一样的实现。
- **类型信息断开**。`runPromise` 返回的是 Promise，失败变成了 rejection，错误通道 `E` 里的精确类型在这里被擦掉。

更隐蔽的是第二类朴素做法：为了「省事」，在每个请求里重新构建一次 Layer。依赖图能工作，但数据库连接池之类的资源被反复创建、反复销毁，成本和泄漏风险都被放大。

## Effect 的做法与心智模型

核心原则只有一句：**run 只发生在边缘，数量尽可能趋近于一**。边缘之内，全是组合，没有执行。

可以用一个类比：Effect 程序像一份菜谱，`run*` 是开火。厨房里应该只有一个灶台开关，所有菜谱都交给它；如果每个厨师都自己带着打火机，你就再也说不清整个厨房的火是谁点的、什么时候该熄。

「边缘」在哪里，取决于宿主的形状。

- **你拥有主循环**：比如脚本、CLI、独立的服务进程。用平台包提供的入口（Node 下是 `NodeRuntime.runMain`），它负责接管信号、中断主 fiber、等 finalizer 跑完再退出。这是最理想的情况，一次运行贯穿整个进程。
- **别人拥有主循环**：比如你只是 Express 里的一堆回调。这时没有一个「整个进程」的入口给你包，只有许多次零散的调用。你需要的是一个**长期存在的、已经装配好依赖的运行环境**，每次回调都从中取用。这就是 `ManagedRuntime`。
- **运行时本身没有进程概念**：比如 Cloudflare Workers，环境绑定随每个请求而来。边缘就是每次 `fetch`，依赖在请求内部装配。

### ManagedRuntime：把 Layer 变成一个可复用的运行环境

`ManagedRuntime.make(layer)` 接受一个不再缺少依赖的 Layer（`R` 为 `never`），返回一个运行时对象。它有两件事要弄清楚。

第一，它**懒惰地构建 Layer**，并且只构建一次。第一次 `runtime.runPromise(...)` 时，Layer 被构建，产出的服务被缓存；之后的调用复用同一份服务。所以数据库连接池只会创建一次。

第二，它**拥有 Layer 的 Scope**。第 10、15 章讲过，Layer 里的 `acquireRelease` 资源挂在 Layer 的 Scope 上，Scope 关闭时才释放。`ManagedRuntime` 持有这个 Scope，直到你调用 `runtime.dispose()`。这意味着：你必须给它一个关闭的时机，否则它持有的连接永远不会被释放。

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

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
      return Db.of({ query: () => Effect.succeed(["row"]) })
    })
  )
}

// 模块顶层只做「定义」：构造运行时对象，不会立刻构建 Layer
export const runtime = ManagedRuntime.make(Db.layer)

// 框架回调里的每一次调用，都复用同一份 Db
export const handler = (sql: string) =>
  runtime.runPromise(Db.use((db) => db.query(sql)))

// 进程退出前的钩子里关闭
export const shutdown = () => runtime.dispose()
```

注意 `ManagedRuntime.make` 本身是纯定义，不会触发 I/O；真正的构建发生在第一次运行时。这点很重要，它让「模块导入」仍然是无副作用的。

### 与框架接合：薄适配层

接入任何框架，写法都是同一个形状：一个 runtime，加上一个很薄的适配函数，把「框架的请求」翻译成「Effect 程序」，再把「Effect 的结果」翻译回「框架的响应」。

```ts
import { Effect } from "effect"

declare const runtime: {
  runPromise: <A, E>(e: Effect.Effect<A, E, any>, o?: { signal?: AbortSignal }) => Promise<A>
}
declare const getUser: (id: string) => Effect.Effect<{ name: string }, never, never>

// 适配层：框架的 Request -> Effect -> Response
export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? ""
  const program = getUser(id).pipe(
    Effect.map((user) => Response.json(user))
  )
  return runtime.runPromise(program, { signal: request.signal })
}
```

这里有三个设计意图。适配层之外，没有任何 `run*`；业务代码是返回 Effect 的普通函数，可以单独测试。失败应该在适配层之内就被翻译成 HTTP 响应（第 5、6 章的「在边界翻译」），而不是让 rejection 冒到框架里，被框架当成 500。最后，把宿主提供的取消信号（`request.signal`）作为 `signal` 传给 `runPromise`：客户端断开时，对应的 fiber 被中断，沿途的 finalizer 会执行。这就是第 13、15 章中断机制在边缘的延伸。

热重载的开发服务器是个特例。模块被反复重新执行，会不断创建新的 `ManagedRuntime`，旧的没有被 dispose。常见的缓解是把 runtime 挂在 `globalThis` 上复用，并在开发环境下明确这是一个妥协：它是为了应对宿主的模块重复执行，而不是 Effect 本身的要求。

### Workers：运行时在请求内部

Cloudflare Workers 的特点是：环境绑定（KV、D1、secrets）来自 `fetch(request, env)` 的参数，而不是进程级全局。所以不能在模块顶层读取 `env`，也就很难在模块顶层构建一个长期的 `ManagedRuntime`。

更自然的做法是：在 `fetch` 里把 `env` 做成一个 Layer，用 `Effect.provide` 提供给本次请求的程序，再 `runPromise`。绑定的生命周期就是这一次请求。

```ts
import { Context, Effect, Layer } from "effect"

class Greeting extends Context.Service<Greeting, { readonly text: string }>()("app/Greeting") {}

interface Env {
  readonly GREETING: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const EnvLive = Layer.succeed(Greeting, Greeting.of({ text: env.GREETING }))
    const program = Greeting.use((g) => Effect.succeed(new Response(g.text)))
    return Effect.runPromise(Effect.provide(program, EnvLive), { signal: request.signal })
  }
}
```

这里的 Layer 很轻，只是把已有的值包起来，每个请求构建一次没有代价。真正昂贵、需要复用的资源，在 Workers 里往往由平台自己的绑定代理，而不是你的 Layer。Workers 上还有一些特有的坑，比如跨请求共享 I/O 对象，这部分单独写在 [Workers 的坑](/articles/effect-workers-pitfalls) 里。

### 一个陷阱：Effect.succeed 会立即捕获

边缘代码里常见一种错误：`Effect.succeed(new SomeRuntimeObject())`。`succeed` 的参数是普通值，在**构造 Effect 的那一刻**就已经求值了，不是运行时才求值。如果这个对象的构造有运行时副作用，或者依赖请求作用域的东西，它就在错误的时间被创建了。需要「运行时才创建」时，用 `Effect.sync(() => new SomeRuntimeObject())`。这和第 2 章的「惰性」是同一个道理：描述里放函数，不要放已经算好的值。

## 常见误区

- **在业务代码里「顺手」run 一下**。凡是 service 方法里出现 `runPromise`，几乎都是边界画错了。把它改成返回 Effect，让调用方去 run。
- **每个请求构建一次 `ManagedRuntime`**。运行时是长期对象，它存在的意义就是复用。每请求构建，等于绕了一圈回到「每请求重建 Layer」。
- **创建了 `ManagedRuntime` 却不 dispose**。测试里尤其明显：测试跑完进程不退出，因为资源没释放。把 dispose 放进测试的收尾或进程退出钩子。
- **在模块顶层运行 Effect**，比如为了「预热」连接。导入期应该只有定义，运行放在入口。这样模块可以被安全地导入、被测试、被打包器分析。
- **手写 `process.on("SIGINT", () => process.exit())`**。这会跳过所有 finalizer。信号处理交给 `runMain`，它会走中断、再走清理。
- **以为 `runtime.runPromise` 的失败还是类型化的**。Promise 的 rejection 里已经没有 `E` 的类型了。在边界之前就把失败翻译掉。

## 小结

运行是 Effect 世界和宿主世界之间的唯一接口。你拥有主循环，就用 `runMain` 一次运行整个程序；宿主有自己的循环，就用 `ManagedRuntime` 持有一份长期的、装配好的依赖，每次回调薄薄地适配一下；运行时没有进程概念（Workers），就把绑定做成 Layer，在每个请求里提供。三种形状共享同一条不变量：run 只在边缘，边缘之内全是描述。

边缘画好了，下一个问题是：程序跑起来之后，你怎么知道它在做什么？下一章讲可观测性：日志、span 和指标，以及在装任何东西之前先想清楚要观测什么。

## 延伸阅读

- [Effect 运行时边界与测试：只在入口 run，用 TestClock 测时间](/articles/effect-runtime-boundaries-and-testing)
- [Effect 在 Workers 里的坑](/articles/effect-workers-pitfalls)
- [Effect 的服务与 Layer](/articles/effect-services-and-layers)
- [Effect Layer 的 memoization](/articles/effect-layer-memoization)
