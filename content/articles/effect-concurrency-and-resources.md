---
title: Effect 并发与资源管理：Fiber、Scope 与中断保证清理
description: 从 Fiber 和 Effect.all/forEach 的并发选项讲到 Scope、acquireRelease，再到中断如何保证清理一定执行。所有代码在 Effect v4 下通过 strict 编译，并标出与 v3 的命名差异。
date: 2026-09-30
category: effect
tags: [effect, guide, concurrency]
---

我喜欢 Effect 的一个核心理由，是它把并发和资源清理放进了同一套语义：并发任务可以被中断，被中断的任务一定会清理资源。这两件事在 Promise 世界里是两套互不相干的手工活，在 Effect 里是一个不变量。

Effect v4 和 v3 在命名上有不少差异，下面遇到的地方我会直接点出来。

## 先说不变量

一句话概括：**一个 Fiber 的生命周期被它的父 Fiber 或 Scope 约束；Fiber 被中断时，它持有的 Scope 按相反顺序关闭，所有已登记的 finalizer 都会运行。**

Promise 做不到这一点：`Promise.all` 里一个失败了，其他的还在后台跑。Effect 让“取消”成为语言的一部分，而不是调用方的礼貌。

## Fiber：轻量的执行单元

Fiber 是 Effect 运行时调度的最小单元。大多数时候你不会直接碰它，`Effect.all` 和 `Effect.forEach` 已经替你创建好了。需要显式管理时，API 如下：

```ts
import { Effect, Exit, Fiber } from "effect"

export const fibers = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(
    Effect.sleep("1 second").pipe(Effect.as("done"))
  )
  const value = yield* Fiber.join(fiber)

  const other = yield* Effect.forkChild(Effect.never)
  yield* Fiber.interrupt(other)
  const exit = yield* Fiber.await(other)

  return { value, interrupted: Exit.hasInterrupts(exit) }
})
```

这里是第一个 v4 差异：v3 的 `Effect.fork` 在 v4 里叫 `Effect.forkChild`，`Effect.forkDaemon` 叫 `Effect.forkDetach`。名字更直白了：`forkChild` 创建的子 Fiber 绑定在父 Fiber 上，父结束或被中断时子会被自动中断；`forkDetach` 脱离父 Fiber，需要你自己负责生命周期，所以用之前请想清楚谁来收尾。另外还有 `Effect.forkScoped`（绑定到当前 Scope）和 `Effect.forkIn`（绑定到指定 Scope）。

`Fiber.join` 把子 Fiber 的结果（包括失败）带回父 Fiber；`Fiber.await` 则返回一个 `Exit`，让你检查它是成功、失败还是被中断。

默认用 `forkChild`；确实需要比父 Fiber 活得久的后台任务，再考虑 `forkScoped`。

## 并发选项：concurrency 才是开关

`Effect.all` 和 `Effect.forEach` 默认是**顺序执行**的。要并发，必须显式给 `concurrency`：

```ts
import { Effect } from "effect"

declare const fetchUser: (id: number) => Effect.Effect<{ id: number }, Error>
const ids = [1, 2, 3, 4, 5, 6]

export const users = Effect.forEach(ids, (id) => fetchUser(id), {
  concurrency: 3
})

export const pair = Effect.all(
  { a: fetchUser(1), b: fetchUser(2) },
  { concurrency: "unbounded" }
)

export const fireAndForget = Effect.forEach(
  ids,
  (id) => Effect.log(`id ${id}`),
  { concurrency: 2, discard: true }
)
```

几点说明：

- `concurrency: 3` 表示同时最多 3 个在跑，相当于 `Promise.all` 加上 `p-limit`，但不需要额外依赖。
- `concurrency: "unbounded"` 不限制并发数。对外部系统（数据库、第三方 API）请求时慎用。
- `Effect.all` 接受元组、数组和对象，结果保持同样的结构。对象形式在组合几个异构请求时很好用。
- `discard: true` 丢弃结果，返回 `void`，省掉收集数组的开销。

默认的失败语义是“快速失败”：一个失败，其余正在运行的会被**中断**，还没开始的直接跳过。我验证过：一个任务 50ms 后失败，另一个 500ms 的任务会收到中断信号。

如果你想让所有任务都跑完，再统一看结果，v4 里用 `mode: "result"`：

```ts
import { Effect } from "effect"

declare const fetchUser: (id: number) => Effect.Effect<{ id: number }, Error>
const ids = [1, 2, 3]

export const results = Effect.all(ids.map(fetchUser), {
  concurrency: 3,
  mode: "result"
})
```

每一项变成一个 `Result`（成功或失败），整体不会因为某一项失败而失败。这是第二个 v4 差异：v3 里叫 `mode: "validate"` 或 `"either"`，v4 统一成了 `"result"`。注意 `mode` 是 `Effect.all` 的选项，`Effect.forEach` 没有，想在 `forEach` 场景用，就像上面那样先 `ids.map` 再交给 `all`。

## Scope：资源的生命周期边界

`try/finally` 的问题是它绑定在词法块上，而资源的生命周期往往不是词法块。Effect 的答案是 `Scope`：一个可以登记 finalizer、关闭时按 LIFO（后进先出）顺序运行它们的容器。

最常用的入口是 `Effect.acquireRelease`：

```ts
import { Effect } from "effect"

interface Conn {
  readonly id: number
  close(): void
}

const open = (id: number) =>
  Effect.acquireRelease(
    Effect.sync((): Conn => ({ id, close: () => console.log("close", id) })),
    (conn) => Effect.sync(() => conn.close())
  )

export const useTwo = Effect.gen(function* () {
  const a = yield* open(1)
  const b = yield* open(2)
  yield* Effect.log(`using ${a.id} ${b.id}`)
  return a.id + b.id
}).pipe(Effect.scoped)
```

`open` 返回的 Effect 类型里带有 `Scope` 这个需求，类型系统会强迫你在某处提供它。`Effect.scoped` 就是划定边界的地方：跑完（无论成功、失败还是被中断），先关 `b` 再关 `a`。如果你忘了 `Effect.scoped`，编译就过不了，而不是线上泄漏。这是我最喜欢的一点：**资源泄漏从运行时问题变成了类型问题。**

不想让 Scope 出现在类型里，可以用三段式 `acquireUseRelease`：

```ts
import { Effect, Exit } from "effect"

export const aur = Effect.acquireUseRelease(
  Effect.succeed({ n: 1 }),
  (resource) => Effect.succeed(resource.n),
  (_resource, exit) => Effect.log(Exit.isSuccess(exit) ? "ok" : "not ok")
)
```

release 阶段会拿到 `Exit`，可以区分成功、失败与中断。需要在 Scope 内临时登记清理动作时用 `Effect.addFinalizer`，它的回调同样能拿到 `Exit`。

## 中断：保证清理的那一半

有了 Scope，再看中断。下面这个例子是我实际跑过的：在子 Fiber 里打开两个资源，然后永远挂起，父 Fiber 在 50ms 后中断它。

```ts
import { Effect, Exit, Fiber } from "effect"

const open = (id: number) =>
  Effect.acquireRelease(
    Effect.log(`open ${id}`).pipe(Effect.as(id)),
    (id) => Effect.log(`close ${id}`)
  )

const program = Effect.gen(function* () {
  yield* open(1)
  yield* open(2)
  yield* Effect.never
}).pipe(Effect.scoped)

export const main = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(program)
  yield* Effect.sleep("50 millis")
  yield* Fiber.interrupt(fiber)
  const exit = yield* Fiber.await(fiber)
  yield* Effect.log(`interrupted=${Exit.hasInterrupts(exit)}`)
})
```

输出顺序是 `open 1`、`open 2`、`close 2`、`close 1`、`interrupted=true`。`Effect.never` 永远不会返回，但清理一样按 LIFO 完成了。`Fiber.interrupt` 会等到 finalizer 跑完才返回，所以你读到 `Exit` 时，资源必然已经释放。

这套机制让几个常见模式变得很自然。

超时与竞速：

```ts
import { Effect } from "effect"

export const raced = Effect.race(
  Effect.sleep("10 seconds").pipe(Effect.as("slow")),
  Effect.sleep("1 second").pipe(Effect.as("fast"))
)

export const guarded = Effect.log("work").pipe(
  Effect.onInterrupt(() => Effect.log("interrupted")),
  Effect.timeout("1 second")
)
```

`Effect.race` 里输家会被中断并清理。`Effect.timeout` 在 v4 里超时会以 `TimeoutError` 失败（进入 `E`，不是 defect）；如果你想要 `Option` 形式，用 `Effect.timeoutOption`。`Effect.onInterrupt` 可以挂一个只在中断时触发的钩子，适合做日志或补偿。

和 Promise 世界对接时，`Effect.promise` 的回调会收到一个 `AbortSignal`，中断 Fiber 就会触发它：

```ts
import { Effect } from "effect"

export const abortable = Effect.promise((signal) =>
  fetch("https://example.com", { signal }).then((r) => r.status)
)
```

这样中断就一路传到了底层的 `fetch`，网络请求真的被取消，而不是在后台白白跑完。

最后是不该被打断的临界区：

```ts
import { Effect } from "effect"

export const critical = Effect.uninterruptible(Effect.log("commit"))
```

`Effect.uninterruptible` 标记的区域内，中断请求会被延后到区域结束。事务提交、文件原子改名这类操作用它包起来。`acquireRelease` 的 release 阶段本来就是不可中断的，所以“清理被清理的人打断”这种问题不会出现。

## 实践建议

- 成对的获取与释放都走 `acquireRelease`，不手写 `try/finally`。
- `concurrency` 永远显式写出来，对外部系统用有限并发，与下游上限对齐。
- 少用 `forkDetach`；必须用时保留 Fiber 引用，或改用 `forkScoped`。

## 小结

并发和资源管理在 Effect 里不是两个特性，而是同一个设计：Fiber 之间是树状结构，Scope 把资源挂在这棵树上，中断沿着树向下传播，沿途所有 finalizer 按 LIFO 顺序运行。你写的是“资源是什么、怎么用”，而不是“出错时要记得清理什么”。

迁移到 v4 时记住这几个名字：`fork` 变 `forkChild`，`forkDaemon` 变 `forkDetach`，`Effect.all` 的 `"validate"` 变 `mode: "result"`，`Effect.timeout` 超时以 `TimeoutError` 失败。

下一篇《Effect 运行时边界与测试：只在入口 run，用 TestClock 测时间》：这些 Effect 最终在哪里、怎么被运行。
