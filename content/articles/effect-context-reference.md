---
title: "Context.Reference：带默认值的服务，取代 FiberRef"
description: Context.Reference 是带默认值的服务键，读取不进 R，局部覆盖不外泄，取代了 v3 的 FiberRef。本文讲 References 内置项，以及 feature flag、per-request 配置的写法与边界。
date: 2026-10-22
tags: [effect, effect-advanced, context, reference, configuration]
category: effect
---

有一类「服务」你并不想让它出现在类型签名里：日志级别、当前请求的租户、特性开关、追踪是否启用。它们有合理的默认值，绝大多数代码只想读，少数入口想临时改一下，改完不能泄漏到别处。

v3 用 `FiberRef` 解这个问题，配套的是 `Effect.locally`、`FiberRef.make`、`FiberRef.get` 一整套带 fiber 语义的 API。我在 effect@4.0.5 里确认过，`FiberRef` 模块已经不存在了。取代它的是 `Context.Reference`：一个**带默认值的服务键**。这个设计的好处是只多了一个概念：它就是 `Context.Service` 的特例，用同样的 `provideService`、`Layer`、`Effect.service` 去读写，不需要学第二套机制。

先看它的定义和读法。再讲内置的 `References`，最后是 feature flag 与 per-request 配置这两个落地场景，以及最重要的一条边界：什么时候不该用它。

## 定义与基本性质

用 `Context.Reference` 创建，必须给 `defaultValue`，它是一个函数：

```ts
import { Context } from "effect"

export const FeatureFlag = Context.Reference<boolean>("myapp/FeatureFlag", {
  defaultValue: () => false
})
```

这是官方文档里的写法。几条我实测过的性质：

- 读取它的 effect，类型里的 R 是 `never`。把 `Effect.gen` 里 `yield* Request` 的结果赋给 `Effect.Effect<...>`（不带 R）能通过编译，所以它不会向上冒泡成「需要提供的依赖」。
- 没人 provide 时读到默认值。默认值函数只会求值一次并缓存：我读了两次，计数器只增加了 1。
- 缓存的是引用本身。如果 `defaultValue` 返回一个可变对象（比如 `new Map()`），所有没有覆盖的读取方拿到的是同一个实例，我用 `Map` 验证过两次读取 `===` 为真。所以默认值要么是不可变的，要么你明确想要全局共享。
- Reference 可以用 `yield*` 直接读，也可以用 `Effect.service(ref)` 读。

覆盖用 `Effect.provideService(effect, ref, value)`，作用域只在这个 effect 内部。`Effect.provide(effect, Layer.succeed(ref, value))` 也可以，适合在应用装配处一次性配置；`Effect.updateService(effect, ref, f)` 在当前值的基础上修改。三种我都跑过。

## 为什么它能取代 FiberRef

`FiberRef` 的核心语义有两条：局部覆盖、fork 时继承。`Context.Reference` 用 Context 本身满足了这两条。Context 在 fiber 之间本来就是随 `forkChild` 传下去的，所以覆盖自然被子 fiber 继承；离计算最近的 `provideService` 生效，所以嵌套覆盖也有清楚的语义。

下面这个例子把几种情况放在一起，同时是 feature flag 和 per-request 配置的最小骨架：

```ts
import { Context, Effect, Fiber, Layer } from "effect"

// 特性开关：默认全部关闭（fail closed）
export const Flags = Context.Reference<ReadonlySet<string>>("app/Flags", {
  defaultValue: () => new Set()
})

// 每个请求的上下文：租户与语言
export interface RequestInfo {
  readonly tenant: string
  readonly locale: string
}
export const Request = Context.Reference<RequestInfo>("app/Request", {
  defaultValue: () => ({ tenant: "public", locale: "zh-CN" })
})

export const isEnabled = (flag: string) =>
  Effect.map(Effect.service(Flags), (flags) => flags.has(flag))

// 深处的业务代码：R 是 never，读取不需要任何 provide
const checkout = Effect.gen(function*() {
  const request = yield* Request
  const newFlow = yield* isEnabled("new-checkout")
  return `${request.tenant}/${request.locale} newFlow=${newFlow}`
})

// 请求入口：用 provideService 覆盖，只对内部生效
const handle = (request: RequestInfo) => Effect.provideService(checkout, Request, request)

const program = Effect.gen(function*() {
  console.log(yield* checkout)
  console.log(yield* handle({ tenant: "acme", locale: "en-US" }))

  // 嵌套覆盖：离计算最近的那一层生效
  const nested = Effect.provideService(
    Effect.provideService(checkout, Flags, new Set(["new-checkout"])),
    Flags,
    new Set()
  )
  console.log(yield* nested)

  // fork 出去的 fiber 继承覆盖
  const forked = Effect.provideService(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(checkout)
      return yield* Fiber.join(fiber)
    }),
    Flags,
    new Set(["new-checkout"])
  )
  console.log(yield* forked)

  // 也可以作为 Layer 提供，适合在应用装配处一次性配置
  const FlagsLive = Layer.succeed(Flags, new Set(["new-checkout"]))
  console.log(yield* Effect.provide(checkout, FlagsLive))
})

Effect.runPromise(program)
```

输出：

```text
public/zh-CN newFlow=false
acme/en-US newFlow=false
public/zh-CN newFlow=true
public/zh-CN newFlow=true
public/zh-CN newFlow=true
```

逐行对应：没有 provide 时走默认值；`handle` 覆盖了租户，开关还是默认关；嵌套时内层的开启生效，不是外层的空集合；`forkChild` 出去的 fiber 看到了覆盖（`forkDetach` 我也试过，同样继承了覆盖值）；`Layer.succeed` 提供的版本在装配处也一样生效。

## 内置的 References

`effect` 的 `References` 模块导出了一批运行时自带的 Reference，v3 里这些是各个 `FiberRef`。常用的几个：

- `MinimumLogLevel`：日志级别阈值，低于它的日志被丢弃，默认 `"Info"`。
- `CurrentLogAnnotations`：附加到每条日志上的注解，默认空对象。
- `CurrentLogLevel`：`Effect.log` 不指定级别时用的级别。
- `TracerEnabled`：是否注册 span，默认 `true`。
- `TracerSpanAnnotations`、`TracerSpanLinks`：附加到之后创建的每个 span 上。
- `Tracer`：当前使用的 tracer 服务。
- `MaxOpsBeforeYield`、`PreventSchedulerYield`：调度器让出 CPU 的预算，属于底层调优，一般不碰。

它们和你自定义的 Reference 没有区别，覆盖方式完全一致。下面是日志侧的行为，都是实际跑出来的：

```ts
import { Effect, References } from "effect"

const work = Effect.gen(function*() {
  yield* Effect.logDebug("debug")
  yield* Effect.logInfo("info")
  yield* Effect.logWarning("warn")
})

const program = Effect.gen(function*() {
  console.log("默认值", yield* References.MinimumLogLevel, yield* References.TracerEnabled)

  console.log("-- MinimumLogLevel = Debug")
  yield* Effect.provideService(work, References.MinimumLogLevel, "Debug")

  console.log("-- MinimumLogLevel = Warn")
  yield* Effect.provideService(work, References.MinimumLogLevel, "Warn")

  console.log("-- CurrentLogAnnotations 直接覆盖")
  yield* Effect.provideService(Effect.logInfo("hello"), References.CurrentLogAnnotations, { requestId: "r-1" })

  console.log("-- annotateLogs 合并")
  yield* Effect.annotateLogs(Effect.annotateLogs(Effect.logInfo("hello"), { a: 1 }), { b: 2 })

  console.log("-- 内层覆盖整体替换")
  yield* Effect.annotateLogs(
    Effect.provideService(Effect.logInfo("hello"), References.CurrentLogAnnotations, { a: 1 }),
    { b: 2 }
  )
})

Effect.runPromise(program)
```

输出（时间戳略）：

```text
默认值 Info true
-- MinimumLogLevel = Debug
DEBUG debug
INFO info
WARN warn
-- MinimumLogLevel = Warn
WARN warn
-- CurrentLogAnnotations 直接覆盖
INFO hello { requestId: 'r-1' }
-- annotateLogs 合并
INFO hello { b: 2, a: 1 }
-- 内层覆盖整体替换
INFO hello { a: 1 }
```

最后两段是重点。`Effect.annotateLogs` 是在**当前值上合并**，所以两次调用的注解都在；而直接 `provideService(CurrentLogAnnotations, ...)` 是**整体替换**。最后一段里内层的整体替换把外层 `annotateLogs` 想加的 `b: 2` 也盖掉了。结论：想「加几个注解」用 `annotateLogs`，只有确实要清空或整体换掉时才直接覆盖 Reference。这也是用原始 Reference 时最容易犯的错：它给你的是最底层的赋值，不是合并。

`TracerEnabled` 的效果我用一个计数的 tracer 验证：

```ts
import { Effect, References, Tracer } from "effect"

const program = Effect.gen(function*() {
  const base = yield* References.Tracer
  let created = 0
  const counting = Tracer.make({
    span(options) {
      created++
      return base.span.call(base, options)
    }
  })

  const traced = Effect.withSpan(Effect.void, "work")
  const run = (effect: Effect.Effect<void>) => Effect.provideService(effect, References.Tracer, counting)

  yield* run(traced)
  console.log("TracerEnabled=true 创建的 span 数", created)
  yield* run(Effect.provideService(traced, References.TracerEnabled, false))
  console.log("关闭后累计 span 数", created)
})

Effect.runPromise(program)
```

输出两行都是 1：开启时创建了一个 span，在局部把 `TracerEnabled` 设为 `false` 之后，tracer 的 `span` 方法根本没有被调用。典型用途是高频的内部循环或健康检查端点，不想给它们产生 span 又不想改业务代码，在入口局部关掉就行。可观测性整体怎么搭，见 [可观测性](/articles/effect-observability)。

## 落地：feature flag 与 per-request 配置

两个场景用的是同一个机制，但我对它们的态度不太一样。

**Feature flag。** 上面的 `Flags` 例子就是推荐形态：默认值是「全部关闭」，读取方一行代码 `isEnabled("new-checkout")`，不关心开关从哪来。生产环境在应用装配处用 `Layer.succeed(Flags, ...)`（或者基于配置、远程服务构建的 Layer）提供真实集合；测试里用 `provideService` 针对单个用例打开某个开关，不需要 mock 任何东西，也不会泄漏到别的用例。默认值我一律选「关」，这样漏提供时是安全的降级，而不是意外上线新流程。

如果开关的值需要异步获取（读远程配置），Reference 的 `defaultValue` 是同步函数，放不下。这时在装配处用 `Layer.effect` 先把结果取出来，再 `Layer.succeed` 或等价地提供进 Reference，业务读取方仍然是同步读。Layer 的写法见 [服务与 Layer](/articles/effect-services-and-layers)。

**Per-request 配置。** 上面的 `Request` 例子：请求入口做一次 `provideService`，下面所有代码，包括内部 `forkChild` 出来的 fiber，都能读到当前租户和语言，而不用把参数逐层传递。并发的两个请求各自在自己的 fiber 树里覆盖，互不影响，这是它和「全局可变变量」本质的区别。

但请注意一点：Reference 适合**横切的、有合理默认值的环境信息**。租户和语言是边界上的例子；而「当前登录用户」就不合适，它没有合理默认值，缺了它业务代码应该编译失败，而不是悄悄以匿名运行。

## 边界与取舍：什么时候用 Service

Reference 把「依赖」从类型里藏起来了，这既是优点也是风险。风险的失败模型很具体：**忘记 provide 的时候没有任何报错，代码静默地使用默认值**。在租户隔离、权限这类场景，这是事故源头。

我的判断标准是一句话：缺失时有没有一个安全的默认值。有（日志级别、开关关闭、追踪开启），用 `Context.Reference`；没有（数据库连接、当前用户、必须存在的凭证），用 `Context.Service`，让类型系统强迫调用方提供，见 [服务与 Layer](/articles/effect-services-and-layers)。

还有两点实用的补充：

- 值的类型尽量只读、不可变，包括默认值。覆盖是整体替换，不是合并，上面 `CurrentLogAnnotations` 的例子已经说明了这一点。需要「在当前值上叠加」的，自己封装成 `updateService` 或像 `annotateLogs` 那样的辅助函数，别让调用方直接面对原始 Reference。
- 给每个 Reference 的 key 加应用前缀（如 `"myapp/Flags"`）。key 字符串是身份，重名会互相覆盖。

## 小结

- `FiberRef` 在 v4 里不存在了，替代品是 `Context.Reference`：有默认值的服务键，读取不进 R，局部覆盖用 `Effect.provideService`，或用 Layer 提供。
- 默认值函数只求值一次并缓存，可变默认值会被所有未覆盖的读取方共享；覆盖对 `forkChild` 和 `forkDetach` 出去的 fiber 都继承，嵌套时最近的一层生效。
- `References` 提供了 `MinimumLogLevel`、`CurrentLogAnnotations`、`TracerEnabled` 等内置项；直接覆盖是整体替换，叠加注解请用 `Effect.annotateLogs`。
- feature flag 和 per-request 配置是最合适的场景；但缺失时没有安全默认值的依赖，应当用 `Context.Service`，让编译器强制提供。
