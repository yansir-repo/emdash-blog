---
title: "Effect.tx 与 TxRef：用事务取代 STM 的共享状态"
description: v4 里 STM 被 Effect.tx 加一组 Tx 数据结构取代。本文讲嵌套事务如何合并、txRetry 如何阻塞重试、怎样原子地改多个 TxRef，以及它和 Ref、Semaphore 的取舍，附实测踩坑。
date: 2026-10-22
category: effect
tags: [effect, advanced, concurrency]
---

共享可变状态里最难的不是「改一个值」，而是「同时改两个值，并且别人任何时刻都看不到改了一半的状态」。`Ref` 能保证单个值的原子更新，但两个 `Ref` 之间没有任何原子性：转账先扣 A 再加 B，中间那一刻别的 fiber 读到的总额就是错的。

v3 的答案是 STM（`STM`、`TRef`、`TMap` 这一整套）。v4 把它换成了另一种形态：`Effect.tx` 定义事务边界，`TxRef`、`TxQueue`、`TxHashMap`、`TxSemaphore`、`TxPubSub` 等数据结构提供可在事务里读写的状态。我在 effect@4.0.5 的包里确认过，已经没有 `STM` 模块，取而代之的是一批 `Tx*` 模块。

最大的变化不是名字，而是事务不再是一个独立的 monad。事务体就是普通的 `Effect`，用 `Effect.gen` 写，里面可以直接 `yield*` 任何 effect。这一点让它好用得多，也埋下了几个必须知道的坑，后面会逐个讲。

## 核心模型：乐观事务加日志

文档对机制的描述很清楚：事务是乐观的。每次读写都记录在事务日志（journal）里，最外层事务成功时一次性提交；提交前如果发现读过的某个 `TxRef` 被别的事务改了，就整体丢弃日志、重跑事务体。事务体抛出失败时，所有写入随日志丢弃，等价于回滚。

三条规则撑起了整个使用面。

1. `Effect.tx(effect)` 是事务边界。在事务里再调用 `Effect.tx` 不会开新事务，而是复用当前的日志和重试状态，这就是「嵌套事务合并」。
2. `Effect.txRetry` 表示「当前条件不满足，等相关数据变了再来」。事务会阻塞，直到本次事务访问过的任一 `TxRef` 发生变化，然后从头重跑事务体。
3. `TxRef.get`、`TxRef.set` 这些操作的类型签名里没有 `Transaction` 依赖，单独调用时各自是一个原子操作。要把多个操作绑成一个整体，才需要显式包 `Effect.tx`。

先看一个最小的对比。下面是两个账户的总额恒为 100，writer 在扣款和入账之间被暂停，reader 在这个窗口里读取：

```ts
import { Deferred, Effect, Fiber, Ref, TxRef } from "effect"

// 两个账户，总额恒为 100。writer 在「扣款」和「入账」之间被暂停，reader 在这个窗口读取。
const plainRefs = Effect.gen(function*() {
  const a = yield* Ref.make(100)
  const b = yield* Ref.make(0)
  const midway = yield* Deferred.make<void>()
  const resume = yield* Deferred.make<void>()

  const writer = Effect.gen(function*() {
    yield* Ref.update(a, (x) => x - 40)
    yield* Deferred.succeed(midway, undefined)
    yield* Deferred.await(resume)
    yield* Ref.update(b, (x) => x + 40)
  })
  const fiber = yield* Effect.forkChild(writer)
  yield* Deferred.await(midway)
  const seen = (yield* Ref.get(a)) + (yield* Ref.get(b))
  yield* Deferred.succeed(resume, undefined)
  yield* Fiber.join(fiber)
  return seen
})

const txRefs = Effect.gen(function*() {
  const a = yield* TxRef.make(100)
  const b = yield* TxRef.make(0)
  const midway = yield* Deferred.make<void>()
  const resume = yield* Deferred.make<void>()

  const writer = Effect.tx(Effect.gen(function*() {
    yield* TxRef.update(a, (x) => x - 40)
    yield* Deferred.succeed(midway, undefined)
    yield* Deferred.await(resume)
    yield* TxRef.update(b, (x) => x + 40)
  }))
  const fiber = yield* Effect.forkChild(writer)
  yield* Deferred.await(midway)
  const seen = yield* Effect.tx(
    Effect.gen(function*() {
      return (yield* TxRef.get(a)) + (yield* TxRef.get(b))
    })
  )
  yield* Deferred.succeed(resume, undefined)
  yield* Fiber.join(fiber)
  return seen
})

Effect.runPromise(plainRefs).then((n) => console.log("Ref 读到的总额", n))
Effect.runPromise(txRefs).then((n) => console.log("TxRef 读到的总额", n))
```

实际输出是 `Ref 读到的总额 60` 和 `TxRef 读到的总额 100`。用 `Ref` 时 reader 看到了被撕裂的状态；用 `TxRef` 时，writer 的写入在提交前只存在于它自己的日志里，reader 读到的是提交前的一致快照。注意 writer 在事务内等待 `Deferred` 并没有死锁，因为事务体是普通 effect，可以挂起。

## txRetry：把「等条件」变成事务的一部分

手写「余额不足就等」要自己配条件变量或者轮询。事务里一行 `Effect.txRetry` 就够了，它不是忙等：事务被挂起，直到读过的 `TxRef` 有变化才被唤醒重跑。

下面这个例子同时演示三件事：每个原语自己包一层 `Effect.tx`、多个账户原子汇总、余额不足时阻塞：

```ts
import { Effect, Fiber, TxRef } from "effect"

// 每个原语自己包一层 Effect.tx：单独调用是一个事务，被组合时并入外层事务
const withdraw = (account: TxRef.TxRef<number>, amount: number) =>
  Effect.tx(Effect.gen(function*() {
    const balance = yield* TxRef.get(account)
    if (balance < amount) return yield* Effect.txRetry // 余额不足：阻塞，直到 account 变化后重跑
    yield* TxRef.set(account, balance - amount)
  }))

const deposit = (account: TxRef.TxRef<number>, amount: number) =>
  Effect.tx(TxRef.update(account, (balance) => balance + amount))

// 从多个账户原子地各扣一笔，汇入同一个账户：要么全部成功，要么什么都没发生
const sweep = (sources: ReadonlyArray<TxRef.TxRef<number>>, target: TxRef.TxRef<number>, each: number) =>
  Effect.tx(Effect.gen(function*() {
    for (const source of sources) {
      yield* withdraw(source, each)
    }
    yield* deposit(target, each * sources.length)
  }))

const program = Effect.gen(function*() {
  const a = yield* TxRef.make(100)
  const b = yield* TxRef.make(10)
  const vault = yield* TxRef.make(0)

  // b 只有 10，sweep 每户要 50：整个事务阻塞在 b 上，a 的扣款对外不可见
  const fiber = yield* Effect.forkChild(sweep([a, b], vault, 50))
  yield* Effect.sleep("20 millis")
  console.log("阻塞中", yield* TxRef.get(a), yield* TxRef.get(b), yield* TxRef.get(vault))

  yield* deposit(b, 60) // b 变化，被阻塞的事务自动重跑并提交
  yield* Fiber.join(fiber)
  console.log("提交后", yield* TxRef.get(a), yield* TxRef.get(b), yield* TxRef.get(vault))
})

Effect.runPromise(program)
```

输出：

```text
阻塞中 100 10 0
提交后 50 20 100
```

这里有三个值得停下来看的点。`withdraw` 和 `deposit` 各自带 `Effect.tx`，单独调用就是事务，被 `sweep` 组合时自动并入外层，我不需要为「独立版」和「可组合版」写两套函数，这是嵌套合并的价值。`sweep` 阻塞期间，a 的余额仍然是 100：先对 a 的扣款只写在日志里，没有提交，外界不可见。最后 `deposit(b, 60)` 改变了 b，阻塞的事务被唤醒，重跑后一次性提交，a、b、vault 同时变化。

唤醒条件是「**本事务访问过的** `TxRef` 变化」。如果你的条件依赖的状态没有通过 `TxRef` 读取（比如读了一个普通变量或外部 API），变化它不会唤醒事务，事务会永远等下去。所有影响判断的状态都必须放在 Tx 结构里。

此外，被阻塞的事务可以像任何 effect 一样被中断或超时，我用 `Effect.timeout` 包住一个永远等待的事务试过，它按预期以超时失败。

## 数据结构：队列、映射、信号量、发布订阅

`TxRef` 是基础，其他结构都建在它上面，所以它们之间可以自由地组合进同一个事务。包里的 Tx 家族有：`TxRef`、`TxQueue`、`TxHashMap`、`TxHashSet`、`TxPriorityQueue`、`TxSemaphore`、`TxReentrantLock`、`TxPubSub`、`TxSubscriptionRef`、`TxDeferred`、`TxChunk`。

组合的价值是「跨结构的原子性」。典型场景是任务认领：从待办队列取走一个任务，同时在 `running` 表里登记谁在处理。分成两步，中间崩溃或被别人观察，就会出现任务既不在队列也不在表里的瞬间。放进一个事务就没有这个窗口：

```ts
import { Effect, Fiber, TxHashMap, TxQueue, TxRef } from "effect"

const program = Effect.gen(function*() {
  const pending = yield* TxQueue.unbounded<string>()
  const running = yield* TxHashMap.empty<string, number>()

  // 取任务与登记「运行中」必须同时发生，否则外部会看到「既不在队列也不在 running」的任务
  const claim = (workerId: number) =>
    Effect.tx(Effect.gen(function*() {
      const job = yield* TxQueue.take(pending) // 队列为空时在事务内阻塞
      yield* TxHashMap.set(running, job, workerId)
      return job
    }))

  const worker = yield* Effect.forkChild(claim(1)) // 队列为空，阻塞
  yield* Effect.sleep("10 millis")
  yield* TxQueue.offer(pending, "job-a")
  const job = yield* Fiber.join(worker)
  console.log(job, yield* TxHashMap.get(running, job), yield* TxQueue.size(pending))

  // 观察一个事务内重跑了几次：副作用会随重试重复
  const gate = yield* TxRef.make(false)
  let bodyRuns = 0
  const waiter = yield* Effect.forkChild(
    Effect.tx(Effect.gen(function*() {
      yield* Effect.sync(() => {
        bodyRuns++
      })
      if (!(yield* TxRef.get(gate))) return yield* Effect.txRetry
    }))
  )
  yield* Effect.sleep("10 millis")
  yield* TxRef.set(gate, true)
  yield* Fiber.join(waiter)
  console.log("事务体执行次数", bodyRuns)

  // 内层事务失败被外层捕获：内层的写入并不会单独回滚
  const outer = yield* TxRef.make("untouched")
  const inner = yield* TxRef.make("untouched")
  yield* Effect.tx(Effect.gen(function*() {
    yield* TxRef.set(outer, "written")
    yield* Effect.tx(Effect.gen(function*() {
      yield* TxRef.set(inner, "written")
      return yield* Effect.fail("inner failed")
    })).pipe(Effect.ignore)
  }))
  console.log(yield* TxRef.get(outer), yield* TxRef.get(inner))
})

Effect.runPromise(program)
```

实际输出：

```text
job-a { _id: 'Option', _tag: 'Some', value: 1 } 0
事务体执行次数 2
written written
```

第一行里 `TxQueue.take` 在空队列上阻塞，有人 `offer` 之后，整个认领事务（取任务加登记）一起完成。`TxQueue.take` 在空队列上会阻塞，而且这个阻塞能发生在更大的事务里面，不需要你自己写 `txRetry`。

后两行是下一节要讲的坑。另外我还单独验证过：`TxSemaphore.withPermit` 配 2 个许可，6 个并发任务的同时运行数峰值是 2；`TxPubSub.subscribe` 需要 `Scope`，返回的是一个 `TxQueue`，订阅者用 `TxQueue.take` 取消息，消息收发均正常。

## 三个必须知道的坑

**坑一：事务体会被重跑，里面的副作用也会重复。** 上面例子里 `Effect.sync` 的计数器在一次阻塞唤醒后是 2。事务体会因为 `txRetry` 或提交时的冲突重新执行，所以在事务体里发请求、写日志、改普通变量都是错的。准则是：事务体里只放对 Tx 结构的读写和纯计算，副作用放到事务提交之后。需要知道当前是第几次尝试时，可以在事务内 `yield* Effect.Transaction`，拿到 `attempt` 和 `retryReason`（`"retry"` 或 `"conflict"`），适合排查为什么事务老在重跑。

**坑二：内层事务不是保存点。** 内层 `Effect.tx` 失败、被外层捕获后，内层的写入仍然留在同一个日志里，最后随外层一起提交，上面输出的 `written written` 就是证明。如果你习惯数据库的 savepoint 语义，期待内层失败只回滚内层，那在这里是不成立的。只有错误穿透到最外层，才会整体回滚。我专门验证过后一点：事务体先写 `TxRef` 再失败，失败后值保持原样。想要「尝试一段，失败就当没发生」的效果，就让它整体失败，或者在写入之前先做检查。

**坑三：Tx 家族并非全部稳定。** 看 JSDoc 的 `@stability` 标注：`Effect.tx`、`Effect.txRetry`、`TxRef`、`TxHashMap`、`TxSemaphore` 等是 stable，但 `TxChunk` 整个模块是 unstable，`TxQueue` 的大多数导出是 unstable，`TxPubSub` 和 `TxSubscriptionRef` 有部分导出是 unstable。依赖它们之前，先查一下你要用的那个函数的标注，unstable 的要做好升级时改写的准备。

## 取舍：Ref、Semaphore 还是 Tx

我的判断顺序是这样的。

- 只有一个值：用 `Ref`。`Ref.modify` 已经是原子的，没有理由引入事务。
- 多个值要保持一致，且能合并成一个值：优先合并成一个 `Ref` 放一个对象，比如 `Ref<{ a: number; b: number }>`，一次 `modify` 搞定。这是最便宜的方案，我会先试它。
- 多个独立的值或数据结构，需要一起改，或者需要「等条件」：这才是 Tx 的主场。`txRetry` 把条件等待和原子更新放进同一个构造里，不用自己拼 `Deferred`、`Semaphore`、重试循环。
- 要限制并发度，且临界区里有任意的异步副作用：用普通的 `Semaphore`，见 [并发与资源](/articles/effect-concurrency-and-resources)。原因正是上面的坑一：事务体可能重跑，不能当互斥区用。`Semaphore` 保证临界区只执行一次，Tx 保证状态变更原子，两者解决的不是一个问题。

`TxSemaphore` 的位置有点微妙。它的许可计数本身是事务状态，所以它可以和别的 Tx 结构放进同一个事务，不过我只单独验证过 `withPermit` 的并发上限，组合用法没有实测。但如果你只是想限流一段异步调用，普通 `Semaphore` 更直接。

另外一点务实的看法：Tx 结构是进程内、内存里的。它不是数据库事务，不跨进程，不持久化；需要跨实例一致性时，应该用数据库事务，见 [SQL 与 RPC](/articles/effect-sql-and-rpc)。

## 小结

- v4 没有 STM 模块了，`Effect.tx` 定义事务边界，`TxRef` 及其家族提供事务内的状态；事务体就是普通 `Effect`。
- 嵌套 `Effect.tx` 会合并进同一个日志，所以原语可以各自带 `tx`、被自由组合；`Effect.txRetry` 让事务阻塞到访问过的 `TxRef` 变化后重跑。
- 事务体会重跑，副作用要放到提交之后；内层失败被捕获不会单独回滚；部分 Tx 模块标注为 unstable。
- 取舍：单值用 `Ref`，能合并成一个值就合并，多个结构需要原子和条件等待用 Tx，需要互斥执行异步副作用用 `Semaphore`。
