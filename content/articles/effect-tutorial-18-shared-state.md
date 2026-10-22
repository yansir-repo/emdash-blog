---
title: "共享状态：Ref、Queue、PubSub、Semaphore 怎么选"
description: 多个 fiber 要共享数据、互相传递工作或限制并发时，该用哪个原语？本章按「要解决的问题」而不是按 API 来分类：Ref 存值、Queue 派活、PubSub 广播、Semaphore 限流，并讲清各自的边界。
date: 2026-10-17
tags: [effect, tutorial, ref, queue, pubsub, semaphore]
category: effect
series: effect-tutorial
seriesOrder: 18
---

第 13、14 章让你开始同时运行多个 fiber。一旦同时跑，就会冒出新问题：它们怎么共享一个计数器？一个 fiber 产生的任务怎么交给另一个？一个事件怎么让好几个 fiber 都知道？同时最多允许几个在跑？这一章不按 API 清单走，而是按这四个问题走，每个问题对应一个原语。

## 朴素做法为什么不够

JavaScript 是单线程的，很多人因此以为共享变量没有竞态。这只对「没有 `await` 的同步片段」成立。凡是读和写之间隔着一个异步点，别的任务就可以插进来：

```ts
let counter = 0

async function bump() {
  const current = counter // 读
  await somethingAsync() // 别的任务在这里插入
  counter = current + 1 // 写：覆盖了别人的更新
}
```

一百个并发的 `bump` 跑完，`counter` 远小于 100。这是经典的「读-改-写」丢失更新。而 Effect 的 fiber 在每个 `yield*` 处都可能被切换，所以同样的问题会原样出现。

此外，用数组当任务队列、用事件回调做广播、用自旋的 `while` 限制并发，都是在重新发明这四个原语，并且通常漏掉背压、取消和关闭语义。

## 选型的核心：先问「你要解决什么」

四个问题，四个原语：

- 我要**保存并更新一个值**：Ref。
- 我要**把工作项交给一个消费者**（每项只被处理一次）：Queue。
- 我要**把事件告诉所有订阅者**（每项被每个人看到）：PubSub。
- 我要**限制同时进行的数量**：Semaphore。

记住这一条就够了：Queue 是「分发」，PubSub 是「广播」。同样是「一个 fiber 发、别的 fiber 收」，语义完全不同。

## Ref：并发安全的一个值

`Ref<A>` 是一个可以原子更新的盒子。它解决的就是上面的丢失更新：把「读-改-写」收拢成**一步**。

```ts
import { Effect, Ref } from "effect"

export const program = Effect.gen(function*() {
  const counter = yield* Ref.make(0)

  yield* Effect.forEach(
    Array.from({ length: 100 }, (_, i) => i),
    () => Ref.update(counter, (n) => n + 1),
    { concurrency: "unbounded", discard: true }
  )

  return yield* Ref.get(counter) // 100
})
```

关键在于不要把读和写拆成两个 Effect。分别用 `Ref.get` 再 `Ref.set` 写回，和裸变量一样会丢更新；一步完成的是 `Ref.update`，需要同时拿到一个返回值时用 `Ref.modify`，它接受 `(当前值) => [返回值, 新值]`。

两条使用纪律：

- 传给 `update` 的函数应当是**纯的、同步的**。它不是 Effect，不要在里面做请求或写库。如果更新过程本身需要执行 Effect，那是 `SynchronizedRef` 的场景（本章不展开）。
- Ref 里放**不可变**的值。更新时返回新对象，不要原地修改再返回同一个引用。

另外，如果你要多个状态一起原子提交，Ref 不够，需要事务；v4 里是 `Effect.tx` 与 `TxRef`，见延伸阅读。

## Queue：有界的任务通道

`Queue` 是生产者与消费者之间的通道。每个元素只会被一个消费者取走，所以它天然适合「任务分发」，比如一个入口接收请求，几个 worker fiber 并行处理。

`Queue.bounded(n)` 是最该优先选择的形态：队列满时，`Queue.offer` 会**挂起**生产者，直到消费者取走一些。这就是上一章的背压，只不过换到了 fiber 之间。生产者被拖慢，系统整体负载就有了上限。

```ts
import { Effect, Fiber, Queue } from "effect"

declare const handle: (job: string) => Effect.Effect<void>

export const program = Effect.gen(function*() {
  const jobs = yield* Queue.bounded<string>(100)

  const worker = Effect.forever(
    Queue.take(jobs).pipe(Effect.flatMap(handle))
  )
  const workers = yield* Effect.forEach(
    [1, 2, 3],
    () => Effect.forkChild(worker)
  )

  yield* Queue.offer(jobs, "job-1")
  yield* Queue.offer(jobs, "job-2")

  yield* Fiber.interruptAll(workers)
})
```

其他几种形态是明确的取舍：

- `Queue.unbounded`：永不阻塞，也永远没有上限；生产者快于消费者时内存会持续增长，只在你能证明量级有限时使用。
- `Queue.dropping(n)`：满了丢新元素。
- `Queue.sliding(n)`：满了丢最旧的元素。

收尾时可以用 `Queue.end` 表示「正常结束」，再配合 `Stream.fromQueue`，把队列接成上一章的流；`Queue.shutdown` 则是直接关掉。

## PubSub：广播给所有订阅者

`PubSub` 是一对多。每个订阅者都会收到发布后的每一条消息。典型用法是一个业务事件同时驱动审计、通知、缓存失效等多个独立的反应。

它有一个必须理解的时序性质：**PubSub 只把消息发给已经订阅的人，不是回放日志**。在订阅之前发布的消息，之后才订阅的人永远收不到。所以要先建立订阅，再开放发布；订阅需要 `Scope`（第 15 章），它随着 Scope 关闭而自动退订。

```ts
import { Effect, PubSub } from "effect"

export const program = Effect.scoped(
  Effect.gen(function*() {
    const events = yield* PubSub.bounded<string>(64)

    const audit = yield* PubSub.subscribe(events)
    const notify = yield* PubSub.subscribe(events)

    yield* PubSub.publish(events, "user-created")

    const a = yield* PubSub.take(audit)
    const b = yield* PubSub.take(notify)
    return [a, b] // 两个订阅者都拿到了
  })
)
```

和 Queue 一样，`bounded` 的 PubSub 在缓冲满了之后会让发布方等待最慢的订阅者，所以一个卡住的订阅者能拖住发布方，进而拖住所有人。`dropping` 与 `sliding` 都不会阻塞发布方，但都要接受丢消息，而且丢法不同：`sliding` 丢最旧的，快的订阅者仍然收到全部，慢的订阅者只剩最新的几条；`dropping` 丢新来的，而「满」是由最慢的订阅者决定的，所以一个慢订阅者会让所有订阅者一起丢掉新消息（以上行为在 4.0.5 里实测过）。需要「慢者不拖累快者」时，`sliding` 才是对的选择。**事件绝对不能丢**的场景，不应该只靠内存里的 PubSub，要有持久化的来源（如数据库里的待发事件表）。

## Semaphore：限制并发，不是限制速率

`Semaphore` 持有 n 个许可。用 `semaphore.withPermits(1)` 包裹一个 Effect，它执行期间占用一个许可；许可用完时，后来者排队等待。

```ts
import { Effect, Semaphore } from "effect"

declare const callApi: (id: number) => Effect.Effect<string>

export const program = Effect.gen(function*() {
  const limit = yield* Semaphore.make(5)
  const limited = (id: number) => callApi(id).pipe(limit.withPermits(1))

  return yield* Effect.forEach(
    Array.from({ length: 100 }, (_, i) => i),
    limited,
    { concurrency: "unbounded" }
  )
})
```

这一百个调用同时被发起，但任一时刻最多 5 个在执行。注意区分：Semaphore 限制的是**同时进行**的数量（并发度），不是**每秒多少次**（速率）。限速需要令牌桶一类的工具，见延伸阅读里的 RateLimiter。

许可数为 1 的 Semaphore 就是互斥锁，适合保护「同一时刻只能有一个在做」的临界区，例如串行化对某个外部资源的写入。而第 14 章里 `concurrency` 选项限制的是一次 `forEach` 的并发度；Semaphore 的价值在于**跨多个调用点共享同一个上限**。

## 常见误区

- **把 `Ref.get` + `Ref.set` 当成原子更新**。要用 `update` 或 `modify`。
- **在 `Ref.update` 的函数里做副作用**。它应当是纯函数。
- **用无界 Queue 图省事**。没有背压的队列只是把问题推迟到内存耗尽的那一刻。
- **把 Queue 当广播用**。多个消费者取同一个 Queue 是在分任务，不是都收到。要都收到，用 PubSub。
- **先发布后订阅**。PubSub 不回放，订阅晚了就是漏了。
- **用 Semaphore 当限速器**。它限制并发，不限制频率。
- **用 Ref 存一切**。当「状态」其实是一个流水线（上游产出、下游消费），用 Stream 或 Queue 表达数据流动，比让大家去读写同一个 Ref 更清晰。

## 小结

选原语不是背 API，而是回答问题：存一个值用 Ref，派活用 Queue，广播用 PubSub，限并发用 Semaphore。它们共同的设计取向是：把「读改写」「排队」「等待」这些容易写错的并发细节，收拢进有明确语义的原语里，并且天然可中断。到这里，第四部分的并发与资源就讲完了。接下来进入工程化：怎样把这套 Effect 程序接进真实的框架与运行时，这是下一章「运行时边界」的主题。

## 延伸阅读

- [Effect 并发与资源安全](/articles/effect-concurrency-and-resources)
- [Effect 事务：TxRef 与 Effect.tx](/articles/effect-transactions-tx)
- [Effect 限流：RateLimiter](/articles/effect-rate-limiter)
- [Effect Stream：背压、分页、扇出与常驻消费者](/articles/effect-streams)
