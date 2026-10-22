---
title: "中断与资源安全：Scope、acquireRelease、finalizer"
description: 讲解为什么 try/finally 在异步与中断场景下不够用，以及 Effect 如何用 Scope、acquireRelease 与 finalizer 保证资源一定释放：获取与释放成对、后进先出、中断时同样生效。
date: 2026-10-14
tags: [effect, tutorial, scope, resource, interrupt]
category: effect
series: effect-tutorial
seriesOrder: 15
---

前两章讲了 fiber 与并发组合子，留下一个悬念：任务被中断的时候，它手里握着的连接、文件、锁怎么办？这一章把这个问题讲透。你会看到，Effect 把「资源释放」从一种需要人记住的纪律，变成了一种由结构保证的性质。

## 要解决的问题

资源的特点是：**有获取，就必须有释放**，而且释放不能因为中间出了什么事而被跳过。打开的文件要关，借来的连接要还，加的锁要解，起的子进程要杀。

在同步代码里，`try/finally` 基本够用。异步世界里，麻烦来了：

- 流程中间可能抛出错误。
- 流程中间可能被取消（用户离开、`race` 的输家、上层超时）。
- 一个流程里可能有多个资源，释放顺序和获取顺序要对得上。
- 资源可能不是在函数里获取的，而是在构造一个服务时获取、在整个应用关闭时才释放。

## 朴素做法为什么不够

最直接的写法是 `try/finally`：

```ts
const conn = await pool.connect()
try {
  return await doWork(conn)
} finally {
  await conn.release()
}
```

对单个资源、单个函数，这没问题。但它有几个结构性的缺陷：

1. **嵌套随资源数量增长。** 两个资源就是两层 try/finally，三个就是三层，顺序全靠缩进保证。
2. **取消与它无关。** Promise 没有中断的概念，所以「在 finally 之前被取消」这件事，在 Promise 世界里根本不是一个被语言表达的状态，要靠 `AbortSignal` 之类的约定。
3. **资源无法跨函数传递。** 想写一个「返回已打开连接」的函数，调用方就必须承担释放责任，而这份责任只存在于文档里。
4. **释放这一步自己也可能出错或被打断**，而 finally 里的 `await` 在取消时没有任何保障。

根本问题是：释放的责任挂在**代码位置**上，而不是挂在**资源本身**上。

## Effect 的做法：把释放挂在 Scope 上

Effect 的做法是引入 **Scope**，可以把它想成「一个资源生命周期的容器」。它有三个性质：

- 往里面登记**清理动作**（finalizer）。
- 当这个 Scope **关闭**时，所有已登记的 finalizer 一定会被执行。
- 执行顺序是**后进先出**（LIFO），和获取顺序相反，就像栈。

「关闭」发生在三种情况：正常结束、失败结束、被中断。**finalizer 不区分这三种原因，都会跑**，而且 finalizer 能拿到一个 `Exit`，知道自己是因为什么而被执行。

### acquireRelease：把获取与释放写在一起

`Effect.acquireRelease` 是最核心的构造器。它接收两个参数：怎么获取，怎么释放。

```ts
import { Effect } from "effect"

interface Conn {
  readonly query: (sql: string) => Promise<unknown>
  readonly close: () => Promise<void>
}
declare const open: () => Promise<Conn>

const connection = Effect.acquireRelease(
  Effect.promise(() => open()),
  (conn) => Effect.promise(() => conn.close())
)
```

注意 `connection` 的类型：它是一个返回 `Conn` 的 Effect，但它的 R 里多了 `Scope.Scope`。这正是第 2 章讲的 `Effect<A, E, R>` 的又一次用法：**R 不只是服务依赖，也可以是「我需要一个 Scope 来托管这个资源」**。一个带着 `Scope` 需求的 Effect，类型上就在提醒你：这里有资源，必须有人划定它的生命周期。

划定生命周期的方式是 `Effect.scoped`，它创建一个 Scope，运行内部的 Effect，并在结束时关闭这个 Scope：

```ts
import { Effect, Scope } from "effect"

declare const connection: Effect.Effect<{ query: (sql: string) => Promise<unknown> }, never, Scope.Scope>

const program = Effect.gen(function*() {
  const a = yield* connection // 获取 A
  const b = yield* connection // 获取 B
  yield* Effect.sleep("10 seconds")
  // 无论这里正常结束、失败还是被中断：先释放 B，再释放 A
}).pipe(Effect.scoped)
```

`Effect.scoped` 一包上，类型里的 `Scope` 需求就被消解了。这也是一个有用的信号：**类型签名上还留着 `Scope.Scope`，说明资源的生命周期还没人负责**。

资源的释放不再是「写在 finally 里的代码」，而是「和资源一起登记的承诺」。不管你在中间 `yield*` 了多少步，不管多少个资源，Scope 关闭时统一按 LIFO 清理。

### 获取与释放对中断的保护

这里有一个细节值得知道：`acquireRelease` 中的**获取**步骤默认是不可中断的（有一个 `interruptible` 选项可以改变），**释放**步骤也不会被中断。实测：获取到一半被中断时，获取会先跑完，随后立刻执行释放，`Fiber.interrupt` 要等这些都结束才返回。设计的理由很朴素：如果获取到一半被打断，你既没有拿到资源，也不知道有没有占着什么，无法清理；如果释放到一半被打断，就等于泄漏。把这两步保护起来，「成对」这个承诺才站得住。

另外，释放动作的类型限定它**不能有可预期的失败**（E 为 never）。这是有意为之：清理是兜底，兜底再失败，没有人可以接着处理。清理里可能出的问题，应该在释放函数内部自己消化（记录日志、忽略），而不是向外抛。

### 两种相关的写法

- `Effect.acquireUseRelease(acquire, use, release)`：三段式，获取、使用、释放写在一个表达式里，不需要外层 `Effect.scoped`。资源只在这一个使用点用到时，它最直观。
- `Effect.addFinalizer`：只登记一个清理动作，不关联获取。需要在当前 Scope 里「顺便」加一个收尾，比如打一条日志、通知对端，就用它。finalizer 会收到 `Exit`，能区分是成功、失败还是中断。

```ts
import { Effect } from "effect"

declare const job: Effect.Effect<string>

const withNotice = Effect.gen(function*() {
  yield* Effect.addFinalizer((exit) =>
    Effect.log(`job finished: ${exit._tag}`)
  )
  return yield* job
}).pipe(Effect.scoped)
```

### 与前两章的会合

现在回头看第 14 章末尾的问题：`Effect.race` 里输掉的一方被中断，它持有的连接去哪了？答案是：只要连接是用 `acquireRelease`（或放进 Scope 的 finalizer）获取的，**中断会触发 Scope 关闭，进而触发 finalizer 释放连接**。

于是三章形成一条完整的链：结构化并发保证「该停的会被中断」，中断保证「Scope 会被关闭」，Scope 保证「finalizer 一定会跑」。没有哪一环依赖开发者「记得」。

Scope 也是 Layer 背后的机制（第 10 章讲过 Layer 有生命周期）：一个 Layer 在构建过程中登记的资源，随着 Layer 的 Scope 关闭而释放，所以应用关闭时，数据库连接池之类的东西会按依赖的逆序被清理。

### 把子 fiber 绑在 Scope 上

第 13 章留了个伏笔：`Effect.forkScoped` 把子 fiber 挂到当前 Scope 上，`Effect.forkIn` 挂到你指定的 Scope 上。含义是：这个后台任务的生命周期不跟父 fiber，而是跟某个资源作用域走，Scope 关闭时它被中断。这对「随服务启动、随服务关闭」的后台循环很合适。

## 常见误区

- **在 `acquireRelease` 之外「顺手」获取资源。** 比如先 `await` 打开连接，再把它塞进 Effect 里用。这样一来，释放的责任又退回到人脑里。获取这一步本身就应该写在 `acquireRelease` 里。
- **忘了 `Effect.scoped`。** 类型会提醒你，因为 `Scope.Scope` 会一直留在 R 里，不会被满足。看到它，不要想着强行 provide 一个，而是想清楚这段资源的生命周期应该在哪里结束。
- **把 Scope 划得太大。** 在整个程序最外层包一个 `scoped`，资源就会一直占到程序结束。划到「用完即还」的最小范围，是资源安全里最常见的取舍。
- **在释放函数里抛业务错误。** 释放不是做业务的地方。类型已经不允许，别想着绕开。
- **用 `Effect.uninterruptible` 大范围保护。** 不可中断的区域内，取消不会生效，运行时间过长会让整个系统「关不掉」。只在确有必要的窄小区间使用；`acquireRelease` 已经为获取与释放做了正确的保护，通常不需要自己再加。
- **把 `Effect.ensuring` 或 `Effect.onExit` 当成资源管理。** 它们适合「无论如何都做一件事」，但不是「获取与释放成对」的表达。有资源，就用 `acquireRelease`。

## 小结

- 资源的释放责任应当挂在资源上，而不是挂在代码位置上，这是 `try/finally` 在异步世界里的结构性缺陷。
- `Scope` 是资源生命周期的容器；finalizer 登记在其中，关闭时按 LIFO 执行，成功、失败、中断一视同仁。
- `Effect.acquireRelease` 让获取与释放成对出现，类型里的 `Scope.Scope` 提醒你生命周期尚未划定，`Effect.scoped` 负责划定。
- 获取与释放受到中断保护，释放不能有可预期失败。
- 结构化并发、中断与 Scope 共同保证：并发任务被取消时，资源也不会泄漏。

到这里，Part 4 的核心模型就齐了：fiber 是执行单元，组合子是并发的形状，Scope 是资源的边界。下一章我们转向时间维度：任务该等多久、失败了多久重试一次，以及退避怎么设计，见 [第 16 章：时间与重试](/articles/effect-tutorial-16-time-and-retry)。

## 延伸阅读

- [Effect 并发与资源](/articles/effect-concurrency-and-resources)
- [Effect fork 家族：forkChild、forkDetach、forkScoped、forkIn 与 startImmediately](/articles/effect-fork-options)
- [Effect Layer 记忆化](/articles/effect-layer-memoization)
- [Effect LayerMap、RcMap 与 Pool](/articles/effect-layermap-rcmap-pool)
