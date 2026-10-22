---
title: "Effect fork 家族：forkChild、forkDetach、forkScoped、forkIn 与 startImmediately"
description: v4 的 fork 系列把子 fiber 挂在哪里、何时被中断，以及 startImmediately 与 uninterruptible 选项。用 PubSub 订阅丢消息复现 fork 后下一个 tick 才执行的竞态，并给出解法。
date: 2026-10-22
category: effect
tags: [effect, advanced, concurrency]
---

fork 是 Effect 里最容易「看起来没问题、偶尔丢数据」的 API。你 fork 了一个消费者，紧接着往队列里发消息，结果消息丢了。排查半天，发现问题不在队列，在于 fork 返回时子 fiber 还没开始执行。v4 给 fork 系列加了两个选项，专门处理这件事。

验证环境是 effect 4.0.5，涉及的 API 都是 stable。并发与资源的整体模型见 [并发与资源](/articles/effect-concurrency-and-resources)，这里专讲 fork 的归属、时机与中断选项。

## 先对一下名字：v3 到 v4

- v3 `Effect.fork` 现在是 `Effect.forkChild`；`Effect.forkDaemon` 现在是 `Effect.forkDetach`。
- `forkScoped` 和 `forkIn` 名字没变，v4 里它们也都接受选项参数。
- 语义没变：`forkChild` 的子 fiber 挂在父 fiber 上，父结束时被中断；`forkDetach` 的子 fiber 挂在全局作用域，父结束后继续运行。

这几条我只在 v4 上跑过，v3 的行为以官方迁移名表为准，没有再装 v3 对比。下面的实测全部是 4.0.5。

## 四个 fork 把子 fiber 挂在哪

- `Effect.forkChild`：挂在当前父 fiber。父 fiber 结束，子 fiber 被中断。
- `Effect.forkDetach`：挂在全局作用域，不随父结束，需要你自己负责中断或等它跑完。
- `Effect.forkScoped`：挂在当前 `Scope`，Scope 关闭时中断。需要环境里有 `Scope`。
- `Effect.forkIn(effect, scope)`：挂在你显式传入的 Scope，Scope 关闭时中断。

用一个会打印生命周期的 worker，把四个都跑一遍：

```ts
import { Effect, Exit, Scope } from "effect"

const log: Array<string> = []
const worker = (name: string) =>
  Effect.gen(function*() {
    log.push(`${name} start`)
    yield* Effect.sleep(30)
    log.push(`${name} done`)
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => { log.push(`${name} interrupted`) })))

// forkChild：父结束，子被中断
await Effect.runPromise(Effect.gen(function*() {
  yield* Effect.forkChild(worker("child"), { startImmediately: true })
  yield* Effect.sleep(5)
}))

// forkDetach：父结束，子继续
await Effect.runPromise(Effect.gen(function*() {
  yield* Effect.forkDetach(worker("detached"), { startImmediately: true })
  yield* Effect.sleep(5)
}))
await Effect.runPromise(Effect.sleep(80))
log.push("---- forkScoped / forkIn")

// forkScoped：Scope 关闭，子被中断
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  yield* Effect.forkScoped(worker("scoped"), { startImmediately: true })
  yield* Effect.sleep(5)
})))

// forkIn：父 fiber 结束后，只要 Scope 没关，子继续；关了才中断
const scope = Effect.runSync(Scope.make())
await Effect.runPromise(Effect.gen(function*() {
  yield* Effect.forkIn(worker("forkIn"), scope, { startImmediately: true })
  yield* Effect.sleep(5)
}))
log.push("parent gone, scope still open")
await Effect.runPromise(Effect.sleep(5))
await Effect.runPromise(Scope.close(scope, Exit.void))
await Effect.runPromise(Effect.sleep(80))
console.log(log)
```

实测输出：

```text
[
  'child start',
  'child interrupted',
  'detached start',
  'detached done',
  '---- forkScoped / forkIn',
  'scoped start',
  'scoped interrupted',
  'forkIn start',
  'parent gone, scope still open',
  'forkIn interrupted'
]
```

`detached` 在父 fiber 早已结束之后还把活干完了；`forkIn` 的子 fiber 在父结束后继续存在，直到我手动关闭 Scope 才被中断。这四种里我的默认选择是 `forkChild`，因为「子随父死」是最不容易泄漏的语义；只有在任务的生命周期确实比发起者长时才用 `forkDetach`，更推荐用 `forkIn` 或 `forkScoped` 把它绑到一个有名字的 Scope 上，而不是丢到全局。

还有一个常被问到的点：子 fiber 失败，父 fiber 不会被自动拖下水。我实测让子 fiber `Effect.fail`，父 fiber 睡 10 毫秒后继续运行，直到 `Fiber.join` 才看到这个失败：

```ts
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  const fiber = yield* Effect.forkChild(Effect.fail("child failed"), { startImmediately: true })
  yield* Effect.sleep(10)
  return yield* Effect.exit(Fiber.join(fiber))
})

const exit = await Effect.runPromise(program)
console.log(exit._tag)
```

输出 `Failure`。所以如果你 fork 之后既不 `join` 也不 `await`，子 fiber 的失败就是静默的。这是 fork 这类「fire and forget」写法的固有风险，不是 v4 引入的。

## 「fork 后第一个 tick 才执行」的竞态

默认情况下，`forkChild` 返回的是 fiber，**子 fiber 要等到调度器的下一个 tick 才开始执行**。API 的 JSDoc 也写得明白：「returning the fiber immediately, without waiting for it to begin executing」。先用最小的例子看顺序：

```ts
import { Effect } from "effect"

const run = async (name: string, startImmediately: boolean) => {
  const log: Array<string> = []
  await Effect.runPromise(
    Effect.gen(function*() {
      const child = Effect.sync(() => log.push("child"))
      yield* Effect.forkChild(child, { startImmediately })
      log.push("parent")
      yield* Effect.yieldNow
    }).pipe(Effect.scoped)
  )
  console.log(name.padEnd(20), log)
}

await run("default", false)
await run("startImmediately", true)

// 父 fiber fork 后立刻结束，不让出
const ran: Array<string> = []
await Effect.runPromise(
  Effect.forkChild(Effect.sync(() => ran.push("child"))).pipe(Effect.asVoid)
)
console.log("parent returns right after fork:", ran)
```

输出：

```text
default              [ 'parent', 'child' ]
startImmediately     [ 'child', 'parent' ]
parent returns right after fork: []
```

默认下 `parent` 先于 `child`。更严重的是最后一行：父 fiber fork 完立刻返回，子 fiber 被中断时**一行代码都没来得及执行**。

这个顺序假设一旦隐含在业务里就是竞态。最典型的就是「先 fork 订阅者，再发布消息」：

```ts
import { Effect, Fiber, PubSub } from "effect"

const scenario = (startImmediately: boolean) =>
  Effect.gen(function*() {
    const hub = yield* PubSub.unbounded<number>()
    const received: Array<number> = []
    const consumer = Effect.scoped(Effect.gen(function*() {
      const sub = yield* PubSub.subscribe(hub)
      const n = yield* PubSub.take(sub)
      received.push(n)
    }))
    const fiber = yield* Effect.forkChild(consumer, { startImmediately })
    yield* PubSub.publish(hub, 1)
    yield* Effect.sleep(20)
    yield* Fiber.interrupt(fiber)
    return received
  })

console.log("default          ", await Effect.runPromise(scenario(false)))
console.log("startImmediately ", await Effect.runPromise(scenario(true)))
```

输出：

```text
default           []
startImmediately  [ 1 ]
```

默认情况下消费者还没来得及 `subscribe`，消息已经发布完了，PubSub 不会为之后才出现的订阅者保留已发布的消息，所以收到空数组。加上 `startImmediately: true`，子 fiber 在 `forkChild` 返回之前就先开始执行，订阅已经建立，随后的发布能被收到。

解法有三个层次，我的顺序是：

1. **能用结构表达就别靠时序**：订阅放在 fork 之前完成，把 `Subscription` 传给消费者。这是最稳的写法，不依赖任何调度细节。
2. **订阅逻辑必须在子 fiber 里时**：`startImmediately: true`。它保证的是「子 fiber 先跑到第一个让出点」，不是「子 fiber 已经完成准备」。如果准备动作跨越了多个异步步骤，仍然需要显式握手，比如 `Deferred`。
3. **不要用 `Effect.sleep` 或 `yieldNow` 凑**：凑出来的间隔在负载变化时又会变成新的竞态。

`startImmediately` 不是 `forkChild` 独有的，`forkScoped`、`forkIn` 和 `forkDetach` 都接受同一组选项，上面生命周期的例子里我就是靠它让每个 worker 在父 fiber 继续之前先打出 `start`。在服务里启动后台循环（心跳、消费者、缓存刷新）时，这个选项尤其有用：服务的构造函数可以在返回前确认循环已经开始运行，调用方拿到服务时不必再猜后台任务有没有就绪。

## uninterruptible 选项

第二个选项 `uninterruptible` 的类型是 `boolean | "inherit"`。我用一个会 sleep 的子 fiber，让父 fiber 5 毫秒后调用 `Fiber.interrupt`，对比三种取值：

```ts
import { Effect, Fiber } from "effect"

const probe = async (label: string, options?: { readonly uninterruptible?: boolean | "inherit" }) => {
  const log: Array<string> = []
  const body = Effect.gen(function*() {
    log.push("start")
    yield* Effect.sleep(30)
    log.push("finished")
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => { log.push("interrupted") })))
  const t0 = performance.now()
  await Effect.runPromise(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(body, { startImmediately: true, ...options })
    yield* Effect.sleep(5)
    yield* Fiber.interrupt(fiber)
  }))
  console.log(label.padEnd(26), log, `interrupt returned after ${Math.round(performance.now() - t0)}ms`)
}

await probe("default")
await probe("uninterruptible: true", { uninterruptible: true })
await probe("uninterruptible: inherit", { uninterruptible: "inherit" })
```

输出（耗时每次略有浮动）：

```text
default                    [ 'start', 'interrupted' ] interrupt returned after 6ms
uninterruptible: true      [ 'start', 'finished' ] interrupt returned after 31ms
uninterruptible: inherit   [ 'start', 'interrupted' ] interrupt returned after 6ms
```

- 默认和 `"inherit"` 在这个场景下一致，子 fiber 被中断。
- `true` 让子 fiber 整个不可中断：中断请求被推迟，`Fiber.interrupt` 要等它自然结束才返回（31 毫秒，而不是 6 毫秒）。
- `"inherit"` 是继承父 fiber 当前的可中断状态。我另外在 `Effect.uninterruptible(...)` 包裹的父 fiber 里 fork，结果子 fiber 同样没有被中断，输出的是 `finished`。

所以 `uninterruptible: true` 适合「必须做完的收尾任务」，比如落盘、提交 offset。代价很直接：它会让中断调用方被阻塞。对「可能永远不结束」的任务，千万不要这么设，否则关闭流程会卡住。我只验证了通过 `Fiber.interrupt` 触发的中断；它对 Scope 关闭时的中断是否同样推迟，我没有实测，不写成结论。

## 怎么选

1. 任务是请求或函数的一部分，随调用方结束：`forkChild`。
2. 任务绑定到某个资源或服务的生命周期：`forkScoped`（当前 Scope）或 `forkIn(scope)`（显式 Scope）。
3. 任务确实要独立于任何父级：`forkDetach`，并明确谁来中断它。
4. fork 之后的下一行代码依赖子 fiber 已经开始：`startImmediately: true`，或者重构成不依赖时序。
5. 子任务必须做完收尾：`uninterruptible: true`，同时保证它会结束。

## 小结

- v3 的 `fork` 和 `forkDaemon` 在 v4 叫 `forkChild` 与 `forkDetach`；四个 fork 的区别只在子 fiber 的归属：父 fiber、全局、当前 Scope、显式 Scope。
- 默认不会立刻执行子 fiber：父 fiber 里 `forkChild` 之后的代码先运行，父立刻结束时子 fiber 可能一行都没跑。
- `startImmediately: true` 让子 fiber 先同步跑到第一个让出点，实测修复了「先 fork 订阅者再发布」丢消息的问题，但不是跨多个异步步骤的就绪保证。
- `uninterruptible: true` 让 `Fiber.interrupt` 等待子 fiber 结束；`"inherit"` 继承父 fiber 的可中断状态。
- 子 fiber 的失败不会自动传给父 fiber，不 `join` 就是静默的。
