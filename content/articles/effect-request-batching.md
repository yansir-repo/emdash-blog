---
title: "Effect RequestResolver：把 N+1 查询合并成批，以及 Cache 的动态 TTL"
description: 用计数器实测 Request.Class、RequestResolver、setDelay、withCache 如何把 N+1 查询合并成批，并介绍 Cache.makeWith 动态 TTL 与 ScopedCache 的惰性过期。
date: 2026-10-22
category: effect
tags: [effect, advanced]
---

N+1 查询是所有「先查列表，再对每一项补查详情」代码的宿命：查 50 篇文章，再为每篇查一次作者，一共 51 次往返。常见的补救是手写 DataLoader，或者在每个调用点预先收集 id 再批量查，前者要管一套调度，后者把批处理的逻辑泄漏到所有调用方。

Effect 的做法是把「我要什么」和「怎么取」拆开：调用方只描述一个 Request，`Effect.request` 把它交给 RequestResolver；resolver 负责把同一时刻到达的一批请求合并成一次真正的查询。调用方写的仍然是「一个 id 查一次」，批处理发生在下面。

这篇文章讲这套机制，并实际用计数器证明批次数。后半部分讲 `Cache` 的动态 TTL 与 `ScopedCache`。全部代码在 effect 4.0.5、`strict` 加 `exactOptionalPropertyTypes` 下编译并运行过；`Request`、`RequestResolver`、`Cache`、`ScopedCache` 的 JSDoc 标注均为 `@stability stable`。

## 先把 N+1 跑出来

先看没有批处理的基线。下面的 `db.queries` 是模拟数据库的往返计数器：

```ts
import { Data, Effect } from "effect"

class AuthorNotFound extends Data.TaggedError("AuthorNotFound")<{ readonly id: number }> {}

const authors = new Map([[1, "Ada"], [2, "Alan"], [3, "Grace"]])
const posts = [
  { title: "p1", authorId: 1 },
  { title: "p2", authorId: 2 },
  { title: "p3", authorId: 1 },
  { title: "p4", authorId: 3 },
  { title: "p5", authorId: 2 }
]

const db = { queries: 0 }

const getAuthor = (id: number): Effect.Effect<string, AuthorNotFound> =>
  Effect.suspend(() => {
    db.queries++
    const name = authors.get(id)
    return name === undefined ? Effect.fail(new AuthorNotFound({ id })) : Effect.succeed(name)
  })

const program = Effect.forEach(posts, (p) => getAuthor(p.authorId), { concurrency: "unbounded" })

Effect.runPromise(program).then((names) => {
  console.log(names, "queries:", db.queries) // [ 'Ada', 'Alan', 'Ada', 'Grace', 'Alan' ] queries: 5
})
```

5 篇文章 5 次查询，哪怕并发也一样：并发只是让这 5 次同时发出，数量没变。

## Request 与 RequestResolver：描述与执行分离

改造分三步。

第一步，用 `Request.Class` 定义请求类型。三个类型参数依次是字段、成功值、错误；第四个是可选的服务依赖。请求实例按字段做结构相等，这点后面做缓存时很关键。

第二步，用 `RequestResolver.make` 写 resolver。它接收一整批 `entries`，每个 entry 带着原始 `request`，你查完之后用 `entry.completeUnsafe(Exit...)` 给每一个请求各自回话。

第三步，调用方用 `Effect.request(request, resolver)`，写法和普通 Effect 无异。

```ts
import { Data, Effect, Exit, Request, RequestResolver } from "effect"

class AuthorNotFound extends Data.TaggedError("AuthorNotFound")<{ readonly id: number }> {}
class GetAuthor extends Request.Class<{ readonly id: number }, string, AuthorNotFound> {}

const authors = new Map([[1, "Ada"], [2, "Alan"], [3, "Grace"]])
const posts = [1, 2, 1, 3, 2, 99].map((authorId, i) => ({ title: `p${i + 1}`, authorId }))

const batches: Array<ReadonlyArray<number>> = []

const resolver = RequestResolver.make<GetAuthor>((entries) =>
  Effect.sync(() => {
    batches.push(entries.map((e) => e.request.id)) // 一次真正的查询
    for (const e of entries) {
      const name = authors.get(e.request.id)
      e.completeUnsafe(
        name === undefined ? Exit.fail(new AuthorNotFound({ id: e.request.id })) : Exit.succeed(name)
      )
    }
  })
)

const getAuthor = (id: number) => Effect.request(new GetAuthor({ id }), resolver)

const program = Effect.forEach(posts, (p) => Effect.exit(getAuthor(p.authorId)), { concurrency: "unbounded" })

Effect.runPromise(program).then((exits) => {
  console.log("batches:", batches.length, JSON.stringify(batches)) // batches: 1 [[1,2,1,3,2,99]]
  console.log(exits.map((e) => (Exit.isSuccess(e) ? "ok" : "fail")).join(" ")) // ok ok ok ok ok fail
})
```

6 个请求只触发了 1 次批处理，每个请求仍然拿到各自的结果，id 99 的失败只影响它自己。调用方的代码和 N+1 版本几乎一样，区别只在 `getAuthor` 的实现。

这里有三个必须知道的事实，都是我跑出来的，不是文档复述。

1. **批处理依赖并发**。如果换成串行的 `Effect.forEach(posts, ...)`，每次都要等上一个完成才发下一个，结果是 6 批、每批 1 个。能合并的前提是请求在同一时刻都已经「挂起」。
2. **默认不去重**。上面那批里 id 1 出现了两次，id 2 也是两次，resolver 收到的是 `[1,2,1,3,2,99]` 而不是去重后的集合。官方示例里「resolver 内部做了去重」的说法，只在叠加 `withCache` 之后才成立，下面会验证。
3. **漏掉 entry 不会卡死**。如果 resolver 没有完成某个 entry，那个请求会以 defect 终止（`Die`），消息是 `RequestResolver did not complete request`，而不是永远挂起。如果 resolver 自己失败了（`Effect.fail`），这一批里所有请求都以该错误失败。这意味着「批量接口少返回了某行」会变成 defect，建议在 resolver 里对缺失的 id 显式 `Exit.fail`，把它当作领域错误而不是漏网之鱼。

## 控制批的形状：setDelay、batchN、makeGrouped

默认情况下没有收集窗口：我实测，每隔 8ms 才到一个的请求各自成批。现实里请求往往就是这样错开几毫秒到达的，这时需要给批一个窗口。

```ts
import { Effect, Exit, Request, RequestResolver } from "effect"

class GetAuthor extends Request.Class<{ readonly id: number }, string> {}

const batches: Array<ReadonlyArray<number>> = []
const base = RequestResolver.make<GetAuthor>((entries) =>
  Effect.sync(() => {
    batches.push(entries.map((e) => e.request.id))
    for (const e of entries) e.completeUnsafe(Exit.succeed(`author-${e.request.id}`))
  })
)

// 请求每隔 8ms 到达一个
const staggered = (r: RequestResolver.RequestResolver<GetAuthor>) =>
  Effect.forEach(
    [1, 2, 3, 4, 5],
    (id) =>
      Effect.sleep(`${id * 8} millis`).pipe(Effect.andThen(Effect.request(new GetAuthor({ id }), r))),
    { concurrency: "unbounded", discard: true }
  )

const program = Effect.gen(function*() {
  yield* staggered(base)
  console.log("no delay:", batches.length, JSON.stringify(batches)) // 5 [[1],[2],[3],[4],[5]]
  batches.length = 0

  yield* staggered(RequestResolver.setDelay(base, "20 millis"))
  console.log("delay 20ms:", batches.length, JSON.stringify(batches)) // 2 [[1,2,3],[4,5]]
})

Effect.runPromise(program)
```

`setDelay` 给批一个收集窗口：第一个请求到达后等待指定时间，期间到达的请求并入同一批。代价是第一个请求的延迟被抬高了一个窗口，所以窗口要按「可接受的额外延迟」来定，通常是几毫秒到几十毫秒。上面的例子里，20ms 窗口把 5 批压成 2 批（[1,2,3] 与 [4,5]）。还有 `setDelayEffect`，窗口可以是任意 Effect，比如等某个信号。

另外两个控制批形状的工具：

- `RequestResolver.batchN(resolver, n)`：单批最多 n 个，超过的拆到后面的批。适合下游接口有 `IN (...)` 上限的场景。我实测 6 个请求、n 等于 2 时得到 3 批
- `RequestResolver.makeGrouped({ key, resolver })`：先按 key 分组，每组各跑一次。适合「同一批里的请求必须发往不同的分片、租户或表」。我实测按 id 奇偶分组时得到 2 批，奇数组与偶数组各一批

选择上，最常用的组合是 `setDelay` 加 `batchN`：前者决定「等多久」，后者决定「最多收多少」。`makeGrouped` 则是在「批的内部结构」必须按维度切开时才用。

## withCache 与 withSpan：去重与可观测

`withCache` 在 resolver 外面包一层有界缓存，缓存以请求的相等性为 key。

```ts
import { Effect, Exit, Request, RequestResolver } from "effect"

class GetAuthor extends Request.Class<{ readonly id: number }, string, string> {}

const batches: Array<ReadonlyArray<number>> = []
const base = RequestResolver.make<GetAuthor>((entries) =>
  Effect.sync(() => {
    batches.push(entries.map((e) => e.request.id))
    for (const e of entries) {
      e.completeUnsafe(e.request.id === 99 ? Exit.fail("not found") : Exit.succeed(`author-${e.request.id}`))
    }
  })
)

const program = Effect.gen(function*() {
  const resolver = (yield* base.pipe(RequestResolver.withCache({ capacity: 100 }))).pipe(
    RequestResolver.withSpan("authors.batch")
  )
  const run = Effect.forEach(
    [1, 2, 1, 3, 2, 99],
    (id) => Effect.exit(Effect.request(new GetAuthor({ id }), resolver)),
    { concurrency: "unbounded", discard: true }
  )

  yield* run
  console.log("first:", JSON.stringify(batches)) // [[1,2,3,99]]
  batches.length = 0
  yield* run
  console.log("second:", JSON.stringify(batches)) // []
})

Effect.runPromise(program)
```

第一轮 resolver 收到的是去重后的 `[1,2,3,99]`，第二轮完全没有触发批处理。几个细节：

- `withCache` 是一个 Effect（要创建缓存），所以要 `yield*` 出来，再继续 `pipe` 其他包装
- 它**没有 TTL**，条目只受容量和 `"lru"`（默认）或 `"fifo"` 淘汰影响。文档的 Gotchas 与我的实测一致：**失败也会被缓存**，上面第二轮里 id 99 的失败没有重试。含中断的结果不缓存
- 缓存命中依赖请求的相等性，所以请求类要用 `Request.Class` 这类带结构相等的定义，字段里别放函数或带身份的对象
- `withSpan(name)` 给每次 resolver 执行包一个 span，并给每个请求建立 span link，把「某个调用点」和「它被合并进的那一批」连起来。没有配置 tracer 时它不改变行为，我只验证了这一点，没有验证 trace 导出的内容

如果需要「过期」，不要用 `withCache`，改用下一节的 `Cache`。

## Cache：动态 TTL

`Cache.make` 是固定 TTL，`Cache.makeWith` 让 TTL 取决于结果。典型用法是成功缓存久一点，失败缓存短一点，避免下游抖一下就把错误缓存十分钟。

```ts
import { Cache, Duration, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

const program = Effect.gen(function*() {
  let lookups = 0
  const cache = yield* Cache.makeWith(
    (key: string) =>
      Effect.suspend(() => {
        lookups++
        return key === "bad" ? Effect.fail("boom") : Effect.succeed(key.length)
      }),
    {
      capacity: 100,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.seconds(5))
    }
  )

  yield* Cache.get(cache, "hello")
  yield* Cache.get(cache, "hello")
  console.log(lookups) // 1：第二次命中

  yield* Effect.exit(Cache.get(cache, "bad"))
  yield* Effect.exit(Cache.get(cache, "bad"))
  console.log(lookups) // 2：失败也被缓存，第二次没有重新查

  yield* TestClock.adjust("6 seconds")
  yield* Effect.exit(Cache.get(cache, "bad"))
  console.log(lookups) // 3：失败条目 5 秒后过期，重新查

  yield* Cache.get(cache, "hello")
  console.log(lookups) // 3：成功条目还在

  yield* TestClock.adjust("10 minutes")
  yield* Cache.get(cache, "hello")
  console.log(lookups) // 4：成功条目过期
}).pipe(Effect.provide(TestClock.layer()))

Effect.runPromise(program)
```

`timeToLive` 的参数是 `(exit, key)`，所以也可以按 key 区分。注意这里用 `TestClock` 把时间快进，这是验证 TTL 逻辑最省事的办法，不需要真的等。

另外两个事实来自 JSDoc：对同一个未命中的 key，并发的 `Cache.get` 共享同一次进行中的查找，不会重复调用 lookup；查找的 `Exit` 被整体缓存，所以失败也会缓存到过期、失效或刷新为止。

`Cache` 与 `RequestResolver` 是互补的：`RequestResolver.asCache(resolver, { capacity, timeToLive })` 把 resolver 直接变成一个以 request 为 key 的 `Cache`，未命中时走 `Effect.request`，于是你同时得到「批处理合并」与「带 TTL 的缓存、失效、刷新」。我验证了：3 个请求（含一个重复）只触发 1 批，快进 2 分钟后同一请求重新触发 1 批。

## ScopedCache：缓存里的值本身是资源

当缓存的值是需要释放的资源（连接、文件句柄、子进程），用 `ScopedCache`。lookup 在每个条目自己的 scope 里运行，条目被淘汰、失效、过期或缓存所在的 scope 关闭时，那个条目的 scope 被关闭，finalizer 随之执行。

```ts
import { Effect, ScopedCache } from "effect"
import { TestClock } from "effect/testing"

const log: Array<string> = []

const program = Effect.gen(function*() {
  const cache = yield* ScopedCache.make({
    capacity: 10,
    timeToLive: "1 minute",
    lookup: (key: string) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push(`open ${key}`)
          return key
        }),
        () => Effect.sync(() => void log.push(`close ${key}`))
      )
  })

  yield* ScopedCache.get(cache, "c")
  yield* TestClock.adjust("2 minutes")
  log.push("-- expired, untouched")
  yield* ScopedCache.get(cache, "c")
  log.push("-- touched")
  yield* ScopedCache.invalidate(cache, "c")
  log.push("-- invalidated")
  yield* ScopedCache.get(cache, "d")
  log.push("-- leaving scope")
}).pipe(Effect.scoped, Effect.provide(TestClock.layer()))

Effect.runPromise(program).then(() => console.log(log.join("\n")))
// open c
// -- expired, untouched
// close c
// open c
// -- touched
// close c
// -- invalidated
// open d
// -- leaving scope
// close d
```

输出里有个值得注意的点：条目过期后，在没有再被访问之前 finalizer **不会**执行（`-- expired, untouched` 之后没有 `close c`），要等下一次访问发现过期，才先关旧的再开新的。所以 ScopedCache 的过期是惰性的，不要指望它像定时器那样准点释放资源；对于对外部有计费或连接数上限的资源，要么配合容量上限，要么显式 `invalidate`。ScopedCache 的类型签名要求外层有 `Scope`，用 `Effect.scoped` 或 layer 的 scope 提供即可，缓存所在 scope 关闭时所有条目一并释放。

## 边界与取舍

什么时候该用批处理：调用点分散、每次只关心一个 id，但底层能一次查多个。典型是 GraphQL 风格的字段解析、列表项各自补充详情的组件、分散在不同模块里的相同查询。

什么时候不该用：

- 只有一个调用点，已经能直接拿到 id 列表：直接写批量查询，别绕一层抽象
- 请求之间有顺序依赖：批处理的前提是同一时刻挂起多个请求，串行流程得不到任何收益
- 延迟极度敏感：`setDelay` 会给第一个请求加上窗口，要么不用，要么窗口设很小

另外两个落地建议。一是把 resolver 做成服务内部的细节，对外只暴露 `getAuthor(id)`，调用方永远不用知道批的存在，这和服务与 Layer 那篇的边界思路一致，参见 [服务与 Layer](/articles/effect-services-and-layers)。二是 resolver 里的失败要分层：整批失败（数据库不可用）用 resolver 自己的错误通道，单个请求的失败（id 不存在）用 `Exit.fail` 完成对应 entry，两者在调用方表现为同样的类型化错误，参见 [类型化错误](/articles/effect-typed-errors)。

## 小结

- `Request.Class` 描述单个请求，`RequestResolver.make` 接收一整批 entries 并逐个 `completeUnsafe`，`Effect.request` 是调用入口
- 批处理的前提是并发：我实测 6 个并发请求合成 1 批，串行则是 6 批
- resolver 默认不去重，叠加 `withCache` 才会去重，且 `withCache` 没有 TTL、失败也被缓存
- `setDelay` 控制收集窗口，`batchN` 限制批大小，`makeGrouped` 按 key 切分，`withSpan` 把批和调用点连起来
- 漏掉某个 entry 会变成 defect，整批失败则所有请求带同一个错误
- 要 TTL 用 `Cache.makeWith` 或 `RequestResolver.asCache`，TTL 可由结果 `Exit` 动态决定；缓存值是资源时用 `ScopedCache`，它的过期是惰性的
