---
title: "Effect Layer 记忆化：v4 里嵌套 provide、fresh 与 local 到底各构建几次"
description: v4 把 MemoMap 在嵌套的 provide 之间共享，v3 的重复构建坑变成了隐式复用。用计数器 Layer 实测嵌套、兄弟、fresh 与 local:true 的构建次数，并说明为什么仍要组合后只 provide 一次。
date: 2026-10-22
tags: [effect, effect-advanced, layer, memoization]
category: effect
---

Layer 的记忆化是 Effect 里最容易被「默认行为」坑到的地方：一个数据库连接池被构建了两次，两份连接，两套缓存，代码却没有任何报错。v4 改了这块的默认语义，但改法比官方迁移文档一句「跨 provide 共享」要细。

这篇我不引用结论，全部用一个计数器 Layer 跑出来。验证环境是 effect 4.0.5。基础的 Layer 组合方式见 [服务与 Layer](/articles/effect-services-and-layers)，这里只讲构建次数。

## 先说结论

- 同一个 Layer 值在一次组合内（`Layer.provide`、`Layer.mergeAll`）天然只构建一次，这点 v3 和 v4 一样。
- v4 新增的是：**嵌套**的 `Effect.provide` 会复用外层已经构建的 Layer。v3 里每次 `Effect.provide` 各有一张记忆表，内层会重复构建。
- **兄弟** `Effect.provide`（并列、互不嵌套）仍然各自构建。这一点和「跨 provide 共享」的字面印象不同，下面有实测。
- 想要独立实例有两个开关：`Layer.fresh(layer)` 决定在 Layer 值上，`Effect.provide(layer, { local: true })` 决定在调用点上。
- 官方建议没有变：**先把依赖图组合好，只 provide 一次**。自动复用是安全网，不是设计手段。

## 计数器 Layer

测试装置很简单：构建一次，计数器加一，把编号放进服务里。后面所有结论都靠这个编号和 `builds` 变量。

```ts
import { Context, Effect, Layer } from "effect"

class Db extends Context.Service<Db, { readonly id: number }>()("Db") {}
class Repo extends Context.Service<Repo, { readonly dbId: number }>()("Repo") {}

let builds = 0
const DbLive = Layer.effect(Db, Effect.sync(() => ({ id: ++builds })))
const RepoLive = Layer.effect(
  Repo,
  Effect.gen(function*() {
    const db = yield* Db
    return { dbId: db.id }
  })
)

// 组合一次：Repo 依赖 Db，同时把 Db 也暴露出去
const AppLive = Layer.provideMerge(RepoLive, DbLive)

const program = Effect.gen(function*() {
  const repo = yield* Repo
  const db = yield* Db
  return [repo.dbId, db.id]
})

const ids = await Effect.runPromise(Effect.provide(program, AppLive))
console.log("ids", ids, "builds", builds)
```

输出是 `ids [ 1, 1 ] builds 1`。Repo 和外部拿到的是同一个 Db。这是基线：一次组合，一次构建。

## 嵌套、兄弟与 local

现在把同一个 `DbLive` 放进四种 provide 形态，每种都重新计数：

```ts
import { Context, Effect, Layer } from "effect"

class Db extends Context.Service<Db, { readonly id: number }>()("Db") {}

let builds = 0
const DbLive = Layer.effect(Db, Effect.sync(() => ({ id: ++builds })))
const useDb = Effect.gen(function*() {
  const db = yield* Db
  return db.id
})

const count = async (label: string, program: Effect.Effect<ReadonlyArray<number>>) => {
  builds = 0
  const ids = await Effect.runPromise(program)
  console.log(label.padEnd(18), "ids", ids, "builds", builds)
}

// 兄弟：并列的两个 provide
await count(
  "sibling",
  Effect.all([
    Effect.provide(useDb, DbLive),
    Effect.provide(useDb, DbLive)
  ])
)

// 嵌套：内层再 provide 一次同一个 Layer
await count(
  "nested",
  Effect.provide(
    Effect.gen(function*() {
      const outer = yield* useDb
      const inner = yield* Effect.provide(useDb, DbLive)
      return [outer, inner]
    }),
    DbLive
  )
)

// 嵌套 + local：内层用自己的记忆表
await count(
  "nested + local",
  Effect.provide(
    Effect.gen(function*() {
      const outer = yield* useDb
      const inner = yield* Effect.provide(useDb, DbLive, { local: true })
      return [outer, inner]
    }),
    DbLive
  )
)

// 组合后只 provide 一次
await count("provide once", Effect.provide(Effect.all([useDb, useDb]), DbLive))
```

实测输出：

```text
sibling            ids [ 1, 2 ] builds 2
nested             ids [ 1, 1 ] builds 1
nested + local     ids [ 1, 2 ] builds 2
provide once       ids [ 1, 1 ] builds 1
```

读法是：嵌套复用，兄弟不复用，`local: true` 把嵌套的复用关掉，一次 provide 永远只构建一次。

原因在源码里看得到。`Effect.provide(layer)` 构建出来的 Context 里，会带上一个 `Layer.CurrentMemoMap` 服务。内层的 provide 从当前 fiber 的 Context 里取这张表，并 fork 出子表：**子表能看到父表已有的条目，但自己新增的条目不会回写父表**。所以兄弟之间互不可见，嵌套才能复用。`{ local: true }` 则直接 `makeMemoMapUnsafe()` 新建一张空表。

## 一个容易忽略的泄漏：外层「看不见」的 Layer 也会被复用

复用依据是记忆表，不是类型。外层 provide 构建了 Db 但没有把 Db 暴露出来（比如 `RepoLive.pipe(Layer.provide(DbLive))`，输出只有 Repo），内层仍然会复用它：

```ts
import { Context, Effect, Layer } from "effect"

class Db extends Context.Service<Db, { readonly id: number }>()("Db") {}
class Repo extends Context.Service<Repo, { readonly dbId: number }>()("Repo") {}

let builds = 0
const DbLive = Layer.effect(Db, Effect.sync(() => ({ id: ++builds })))
const RepoLive = Layer.effect(
  Repo,
  Effect.gen(function*() {
    const db = yield* Db
    return { dbId: db.id }
  })
)
const RepoOnDb = RepoLive.pipe(Layer.provide(DbLive))

const useDb = Effect.gen(function*() {
  const db = yield* Db
  return db.id
})

const program = (local: boolean) =>
  Effect.provide(
    Effect.gen(function*() {
      const repo = yield* Repo
      const inner = yield* Effect.provide(useDb, DbLive, { local })
      return [repo.dbId, inner]
    }),
    RepoOnDb
  )

console.log("shared", await Effect.runPromise(program(false)), "builds", builds)
builds = 0
console.log("local ", await Effect.runPromise(program(true)), "builds", builds)
```

输出是 `shared [ 1, 1 ] builds 1` 和 `local  [ 1, 2 ] builds 2`。内层拿到的 Db 和 Repo 内部用的是同一个实例。大多数时候这正是你想要的，但如果内层 Db 的意图是「我要自己的一份」，默认行为会悄悄违背它。这时必须显式写 `local: true`，而不是指望类型系统提醒。

## fresh 与 local 的区别

两者都能强制重新构建，区别在**决定权放在哪**，以及它覆盖的范围。

- `Layer.fresh(layer)`：决定写在 Layer 值上。任何使用它的地方都拿到独立实例，包括它的整棵子依赖树。适合「这个资源就是不该共享」的语义，比如两个互相独立的客户端会话。
- `Effect.provide(layer, { local: true })`：决定写在调用点。同一个 Layer 值在别处依然共享。适合测试里「这一次 provide 要隔离」的场景。

范围这件事我用一个带子依赖的 Layer 实测了。`RepoOnDb` 内含 Db，外层先 provide 一次，内层再 provide 第二次：

```ts
import { Context, Effect, Layer } from "effect"

class Db extends Context.Service<Db, { readonly id: number }>()("Db") {}
class Repo extends Context.Service<Repo, { readonly dbId: number; readonly repoId: number }>()("Repo") {}

let dbBuilds = 0
let repoBuilds = 0
const DbLive = Layer.effect(Db, Effect.sync(() => ({ id: ++dbBuilds })))
const RepoLive = Layer.effect(
  Repo,
  Effect.gen(function*() {
    const db = yield* Db
    return { dbId: db.id, repoId: ++repoBuilds }
  })
)
const RepoOnDb = RepoLive.pipe(Layer.provide(DbLive))

const describe = Effect.gen(function*() {
  const r = yield* Repo
  return `repo${r.repoId}/db${r.dbId}`
})

const run = async (label: string, inner: Layer.Layer<Repo>) => {
  dbBuilds = 0
  repoBuilds = 0
  const out = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const a = yield* describe
        const b = yield* Effect.provide(describe, inner)
        return [a, b]
      }),
      RepoOnDb
    )
  )
  console.log(label.padEnd(20), out, "db", dbBuilds, "repo", repoBuilds)
}

await run("plain", RepoOnDb)
await run("fresh(whole)", Layer.fresh(RepoOnDb))
await run("fresh(Repo only)", Layer.fresh(RepoLive).pipe(Layer.provide(DbLive)))
```

输出：

```text
plain                [ 'repo1/db1', 'repo1/db1' ] db 1 repo 1
fresh(whole)         [ 'repo1/db1', 'repo2/db2' ] db 2 repo 2
fresh(Repo only)     [ 'repo1/db1', 'repo2/db1' ] db 1 repo 2
```

读法：`Layer.fresh(RepoOnDb)` 把 Repo 和它下面的 Db 都重新构建了（db 2、repo 2）。只对 `RepoLive` 套 fresh、Db 另行 provide，则只有 Repo 是新的，Db 仍然共享（db 1、repo 2）。换句话说，**fresh 的粒度由你把它套在哪一层决定**，套在包含子依赖的 Layer 上，子依赖一起被隔离。`{ local: true }` 在这个例子里的效果和 `fresh(whole)` 一样，因为它给整个 provide 子树换了一张空记忆表。

我自己的取舍：

1. 资源语义上必须独立（两个会话、两个连接池）：用 `Layer.fresh`，让意图写在 Layer 定义旁边，不依赖调用方记得加参数。
2. 测试里想让某一次 provide 与外层完全隔离：用 `{ local: true }`，不需要改 Layer 定义。
3. 官方 JSDoc 也提醒过：不要为了绕开「看不懂的组合」而用 `Layer.fresh`，默认共享通常才是想要的。

## 为什么还是要「组合后只 provide 一次」

既然嵌套 provide 会自动复用，是不是可以随手到处 `Effect.provide`？不行，理由有三个，都能从上面的实测推出来。

- **兄弟不共享。** `Effect.all` 里并列两个 provide 就是两份构建。自动复用只覆盖「内层在外层作用域里」这一种形态，稍微换一下代码结构，行为就变了。
- **隐式泄漏。** 外层藏在内部的 Layer 也会被内层复用，依赖图在类型上看不出来，只有读源码或加计数器才知道。
- **生命周期。** 兄弟构建两次意味着资源的 acquire 与 release 也各两次。资源型 Layer（连接池、文件句柄）出现这种情况，通常就是线上多出一份连接。

组合一次则没有这些问题：依赖图在一处显式写出，构建次数等于图里的节点数，释放顺序由 Scope 决定。迁移文档的说法是自动记忆化「是安全网，不是组合的替代品」，我同意，也把它当成 review 规则：**一个应用入口只出现一次 `Effect.provide(AppLive)`**（运行时入口怎么组织见 [运行时边界与测试](/articles/effect-runtime-boundaries-and-testing)）。

## 计数器 Layer 作为回归测试

构建次数是可以断言的行为，不必靠肉眼。上面的计数器模式可以直接放进测试：给关键资源 Layer 加一个构建计数，在测试里组装应用 Layer，断言 `builds === 1`。以后有人在中间加了一层 `Effect.provide`，或者把 Layer 包进了 `fresh`，测试会第一时间失败。

要注意一点：我只在 `Effect.runPromise` 的单次运行里验证了嵌套与兄弟的行为。像 `HttpRouter`、`LayerMap` 这类内部自己 fork 记忆表的模块，源码里能看到它们用 `CurrentMemoMap.forkOrCreate`，但它们各自的复用边界我没有逐一实测，用到时请自己加计数器确认。

## 小结

- 一次组合内，同一个 Layer 值只构建一次。
- v4 的变化：嵌套的 `Effect.provide` 共享外层记忆表（子表继承父表，新条目不回写），所以内层复用外层；兄弟 provide 依旧各自构建。
- 复用依据是记忆表而不是类型，外层未暴露的 Layer 也会被内层复用。
- `Layer.fresh` 把「不共享」写进 Layer 值，范围包含子依赖；`{ local: true }` 把它写进调用点，同样隔离整棵子树。
- 官方建议和我的做法一致：组合依赖图，入口只 provide 一次，用计数器 Layer 把构建次数变成可断言的测试。
