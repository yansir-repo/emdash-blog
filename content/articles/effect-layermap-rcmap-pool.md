---
title: "Effect 资源类 API：LayerMap、RcMap、Pool、LayerRef 与 Resource 怎么选"
description: 按「有没有 key、要不要共享、要不要刷新」梳理 Effect 4.0.5 的五个资源 API：LayerMap 做多租户 Layer 缓存，RcMap 按 key 共享，Pool 做连接池，LayerRef 与 Resource 负责刷新，并标明稳定性。
date: 2026-10-22
tags: [effect, effect-advanced, layermap, rcmap, pool, resource]
category: effect
---

[并发与资源](/articles/effect-concurrency-and-resources)那篇讲了 `Scope` 和 `acquireRelease`：一个资源，一个生命周期。真实系统里很快会遇到三种变形：资源按 key 区分（每个租户一个连接）、资源需要复用而不是每次新建（连接池）、资源会过期需要刷新（token、配置快照）。Effect 为这三种变形各给了一个原语，名字很像，边界很清楚。

这篇我按一个问题来组织：**你的资源有没有 key，要不要被多个调用方同时共享，会不会过期**。所有行为都在 `effect@4.0.5` 里实际跑过。

## 先看稳定性

先说一个容易漏掉的事实：这五个模块的稳定性并不一致。我扫描了 4.0.5 的 `dist/*.d.ts` 里的 `@stability` 标签：

- `RcMap`、`Pool`、`Resource` 是 `stable`。
- `LayerMap`、`LayerRef` 是 `unstable`，小版本里 API 可能变。

所以我的取舍是：生产代码里可以放心用 `Pool` 和 `RcMap`；`LayerMap` 很好用，但它是 unstable，建议只在应用层用一处封装，别让它散落在业务代码里。稳定性机制本身见[稳定性标注那篇](/articles/effect-stability-tags)。

## RcMap：按 key 共享、引用计数释放

`RcMap` 是最底层的积木：给一个 `lookup: key -> 带 Scope 的 Effect`，同一个 key 的并发调用只会 acquire 一次，所有持有者的 `Scope` 都关闭后资源才释放。

```ts
import { Cause, Effect, RcMap } from "effect"

const program = Effect.gen(function*() {
  const map = yield* RcMap.make({
    lookup: (key: string) =>
      Effect.acquireRelease(
        Effect.sync(() => `conn:${key}`),
        () => Effect.log(`close ${key}`)
      ),
    idleTimeToLive: "100 millis",
    capacity: 2
  })

  // 同一个 scope 里取两次同一个 key，只 acquire 一次
  yield* Effect.scoped(Effect.all([RcMap.get(map, "a"), RcMap.get(map, "a")]))
  // 等 idleTimeToLive 过去，"a" 才会真正释放并让出容量
  yield* Effect.sleep("300 millis")

  // 超过 capacity 时，get 以 ExceededCapacityError 失败
  const exit = yield* Effect.scoped(
    Effect.gen(function*() {
      yield* RcMap.get(map, "x")
      yield* RcMap.get(map, "y")
      return yield* RcMap.get(map, "z").pipe(Effect.exit)
    })
  )
  if (exit._tag === "Failure") {
    console.log(Cause.pretty(exit.cause).split("\n")[0])
  }
})

Effect.runPromise(Effect.scoped(program))
```

实测：最后一个 scope 关闭后，`a` 并不立刻释放，而是等满 `idleTimeToLive` 才 `close a`，所以上面的代码要先 sleep；否则 `a` 仍占着容量，第二个 key 就会失败。让出容量后再取第三个 key，得到 `ExceededCapacityError: RcMap attempted to exceed capacity of 2`。文档里的措辞是它「不是通用的可变缓存」，我同意：它管的是**有生命周期的资源**，不是 `Map<string, Value>`。需要值缓存请用 `Cache`。

## LayerMap：RcMap 加上 Layer 的外壳

`LayerMap` 的 `rcMap` 字段直接暴露了底层的 `RcMap`，它做的事是把「key 到资源」换成「key 到 Layer」：`get(key)` 返回一个 `Layer`，你照常 `Effect.provide`，下游代码完全不知道租户的存在。这正是多租户场景要的：业务函数只写 `yield* TenantDb`，租户在边界处选择。

```ts
import { Context, Effect, Layer, LayerMap } from "effect"

class TenantDb extends Context.Service<TenantDb, {
  readonly tenant: string
  readonly query: (sql: string) => Effect.Effect<string>
}>()("app/TenantDb") {
  static readonly layer = (tenant: string) =>
    Layer.effect(
      TenantDb,
      Effect.acquireRelease(
        Effect.sync(() =>
          TenantDb.of({ tenant, query: (sql) => Effect.succeed(`[${tenant}] ${sql}`) })
        ),
        (db) => Effect.log(`release ${db.tenant}`)
      )
    )
}

class Tenants extends LayerMap.Service<Tenants>()("app/Tenants", {
  lookup: (tenant: string) => TenantDb.layer(tenant),
  idleTimeToLive: "1 minute"
}) {}

const listUsers = TenantDb.use((db) => db.query("select * from users"))

const program = Effect.gen(function*() {
  const a = yield* listUsers.pipe(Effect.provide(Tenants.get("acme")))
  const b = yield* listUsers.pipe(Effect.provide(Tenants.get("globex")))
  yield* Tenants.invalidate("acme") // 下次访问重建
  console.log(a, b)
}).pipe(Effect.provide(Tenants.layer))

Effect.runPromise(program)
```

我实测了三个行为，都和直觉有一点出入：

1. 同一个 key 连续两次 `Effect.provide(Tenants.get("acme"))`，只构建一次；四个并发的同 key 调用也只构建一次。
2. `invalidate` 会让当前缓存项被移除，下一次访问重新构建；已经借出的 context 在其 scope 关闭前仍可用。
3. **不写 `idleTimeToLive` 时，缓存只在借用期间存在**。我连续三次顺序 provide 同一个 key，得到三次构建。想真正跨请求复用，必须设置 `idleTimeToLive`。

另外，`lookup` 是函数，key 空间可以是开放的；key 空间固定时用 `layers` 选项（或 `LayerMap.fromRecord`），类型上 key 会收窄成字面量联合。`contextEffectOption` 只读已缓存的项，不会触发构建，适合探测。

## Pool：不是按 key，而是同类资源的复用

`Pool` 解决的是另一个问题：同一种资源（数据库连接、worker）创建昂贵，需要一批复用，并限制并发。`Pool.make` 是固定大小，`Pool.makeWithTTL` 是 `min` 到 `max` 弹性伸缩，超出 `min` 的空闲项在 `timeToLive` 后回收。

```ts
import { Effect, Pool } from "effect"

let created = 0

const program = Effect.gen(function*() {
  const pool = yield* Pool.makeWithTTL({
    acquire: Effect.acquireRelease(
      Effect.sync(() => ({ id: ++created })),
      () => Effect.void
    ),
    min: 1,
    max: 3,
    timeToLive: "100 millis"
  })

  // 6 个并发任务，最多只会创建 3 个连接
  const ids = yield* Effect.all(
    [1, 2, 3, 4, 5, 6].map(() =>
      Pool.use(pool, (conn) => Effect.as(Effect.sleep("50 millis"), conn.id))
    ),
    { concurrency: "unbounded" }
  )
  console.log(ids, created)

  // 发现某个连接坏了：invalidate 之后池会惰性补一个新的
  yield* Effect.scoped(
    Effect.gen(function*() {
      const conn = yield* Pool.get(pool)
      yield* Pool.invalidate(pool, conn)
    })
  )
})

Effect.runPromise(Effect.scoped(program))
```

实测结果：6 个并发任务只创建了 3 个连接，id 被复用；等待超过 TTL 后，创建过 3 个、关闭了 2 个，收缩回 `min = 1`；`invalidate` 之后下一次取到的是新建的第 4 个。几个细节：

- 单个借用用 `Pool.use`，它不需要额外分配 scope；需要把借用期绑定到某个 scope 才用 `Pool.get`。
- `concurrency` 默认是 1，即每个连接同一时刻只给一个 fiber；支持多路复用的客户端可以调大。
- `invalidate` 按严格相等匹配，传一个「长得一样」的对象不会生效。
- `timeToLive` 默认按「最后一次归还」计时，且按 TTL 周期检查，所以实际回收最长可能拖到两倍 TTL。

## LayerRef 与 Resource：会过期的资源

这两个都是「单个资源 + 刷新」，区别在抽象层级：`LayerRef` 缓存的是一个 Layer 构建出的整个 `Context`，`Resource` 缓存的是一个 Effect 的结果。

`LayerRef`（unstable）是无 key 版的 LayerMap，底层是 `RcRef`。除了 `invalidate`，还有 `refresh`（失效并立即重新获取），以及 `invalidationSchedule` 做周期性失效。文档里有一条要记住：失效不会撤销已借出的 context，它们在各自 scope 关闭前仍可用。

`Resource`（stable）更轻：`Resource.manual` 由你调用 `refresh`，`Resource.auto` 按 `Schedule` 在后台刷新，`Resource.get` 永远返回当前缓存值。

```ts
import { Context, Effect, Layer, LayerRef, Resource, Schedule } from "effect"

let n = 0
class Cfg extends Context.Service<Cfg, { readonly version: number }>()("app/Cfg") {
  static readonly layer = Layer.effect(Cfg, Effect.sync(() => Cfg.of({ version: ++n })))
}
const readVersion = Cfg.use((cfg) => Effect.succeed(cfg.version))

const program = Effect.gen(function*() {
  const ref = yield* LayerRef.make(Cfg.layer, { idleTimeToLive: "1 second" })
  const a = yield* readVersion.pipe(Effect.provide(ref.get))
  const b = yield* readVersion.pipe(Effect.provide(ref.get))
  yield* ref.invalidate
  const c = yield* readVersion.pipe(Effect.provide(ref.get))
  yield* ref.refresh
  const d = yield* readVersion.pipe(Effect.provide(ref.get))
  console.log("LayerRef", a, b, c, d)

  let tick = 0
  const manual = yield* Resource.manual(Effect.sync(() => ++tick))
  const x = yield* Resource.get(manual)
  const y = yield* Resource.get(manual)
  yield* Resource.refresh(manual)
  const z = yield* Resource.get(manual)
  console.log("manual", x, y, z)

  const auto = yield* Resource.auto(Effect.sync(() => ++tick), Schedule.spaced("100 millis"))
  const first = yield* Resource.get(auto)
  yield* Effect.sleep("350 millis")
  const later = yield* Resource.get(auto)
  console.log("auto", first, later)
})

Effect.runPromise(Effect.scoped(program))
```

输出是 `LayerRef 1 1 2 3` 和 `manual 1 1 2`：缓存命中不重建，`invalidate` 与 `refresh` 各让版本号前进一次。`auto` 的 `later` 比 `first` 大，说明后台在刷新；精确的刷新次数取决于调度，我没有把它当作契约。

## 怎么选

1. 资源有 key、要共享、要自动释放：`RcMap`。
2. 资源有 key、而且想按 key 切换整套 Layer（多租户、多区域）：`LayerMap`，记得设 `idleTimeToLive`。
3. 同类资源批量复用并限流：`Pool`，弹性的用 `makeWithTTL`。
4. 单个 Layer 构建的服务需要失效重建：`LayerRef`。
5. 单个值需要手动或定时刷新（token、远程配置）：`Resource`，它比 `LayerRef` 简单，能用就别上 Layer。

## 小结

五个 API 其实是两条轴：有无 key（`RcMap`/`LayerMap` 对 `LayerRef`/`Resource`），以及复用还是刷新（`Pool` 复用，`Resource`/`LayerRef` 刷新）。稳定性上 `LayerMap` 与 `LayerRef` 都是 unstable，用的时候把它们收在一个模块里。最容易踩的是 `LayerMap` 不配 TTL 时的「每次都重建」，以及 `Pool.invalidate` 的严格相等匹配。
