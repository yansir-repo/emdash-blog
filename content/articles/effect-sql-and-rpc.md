---
title: "Effect 的 SQL 与 RPC：Schema 驱动的数据模型、事务与共享契约"
description: 用 effect/sql 的 Model 从一份字段声明派生数据库与 JSON 变体，用 withTransaction 保证回滚，再用 effect/rpc 把契约放进共享文件，让传输失败和业务错误在类型里各归其位。
date: 2026-10-10
tags: [effect, sql, rpc, schema]
category: effect
---

数据库行和 RPC 消息，是我认为和 HTTP 同一类的东西：它们都是越过进程边界的数据，都不可信，都会以各种方式失败。前几篇讲过的东西在这里几乎原样复用：Schema 在入口处解码，TaggedError 描述预期失败，defect 留给「不该发生」的事，Layer 切换实现。这一篇把它们落到 `effect/sql` 和 `effect/rpc` 上。

先交代验证范围。SQL 部分我用的是内存 SQLite（`@effect/sql-sqlite-node`），所有行为都是在它上面实际跑过的；PostgreSQL、MySQL 的驱动包在 npm 上同样有 4.0.5 版本，但我没有数据库可连，下面凡是涉及驱动差异的地方，我会明说我只验证了 SQLite。包布局和上一篇一样：`SqlClient`、`Model`、`SqlSchema`、`Rpc` 都在 `effect` 本体里（`effect/sql`、`effect/schema`、`effect/rpc`），只有驱动适配是独立包，并且这些模块都标注为 unstable。

## 一份字段声明，派生出所有变体

数据模型最常见的坑是「同一个实体写了四遍」：数据库行一个类型，插入时一个类型（没有自增 id），更新时一个类型，返回给前端又一个类型（不能带内部字段）。四份定义一定会漂移。`Model.Class` 的做法是只写一份字段声明，再用修饰器标注每个字段属于哪些变体，其余的由它派生。

```ts
// file: sql.ts
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Model } from "effect/schema"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

export class Account extends Model.Class<Account>("Account")({
  id: Model.UuidV4Insert(AccountId),
  owner: Schema.NonEmptyString,
  balance: Schema.Int,
  secretNote: Schema.String.pipe(Model.FieldOnly(["select", "insert", "update"])),
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate
}) {}

export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", { id: AccountId }) {}
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  id: AccountId,
  balance: Schema.Int
}) {}

export const SqlLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_accounts": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE accounts (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, balance INTEGER NOT NULL,
        secretNote TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`
    })
  })
}).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

export class Accounts extends Context.Service<Accounts, {
  open(owner: string, balance: number): Effect.Effect<Account>
  get(id: AccountId): Effect.Effect<Account, AccountNotFound>
  transfer(from: AccountId, to: AccountId, amount: number): Effect.Effect<void, AccountNotFound | InsufficientFunds>
  richerThan(min: number): Effect.Effect<ReadonlyArray<Account>>
}>()("app/Accounts") {
  static readonly layerNoDeps = Layer.effect(
    Accounts,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const repo = yield* SqlModel.makeRepository(Account, {
        tableName: "accounts",
        spanPrefix: "Accounts",
        idColumn: "id"
      })
      const richer = SqlSchema.findAll({
        Request: Schema.Int,
        Result: Account,
        execute: (min) => sql`SELECT * FROM accounts WHERE balance > ${min} ORDER BY balance DESC`
      })

      const open = (owner: string, balance: number) =>
        Account.insert.makeEffect({ owner, balance, secretNote: "" }).pipe(
          Effect.flatMap(repo.insert),
          Effect.orDie
        )

      const get = (id: AccountId) =>
        repo.findById(id).pipe(
          Effect.catchTags({
            NoSuchElementError: () => Effect.fail(new AccountNotFound({ id })),
            SchemaError: Effect.die,
            SqlError: Effect.die
          })
        )

      const adjust = (id: AccountId, delta: number) =>
        Effect.gen(function*() {
          const acc = yield* get(id)
          const balance = acc.balance + delta
          if (balance < 0) return yield* new InsufficientFunds({ id, balance: acc.balance })
          yield* sql`UPDATE accounts SET balance = ${balance} WHERE id = ${id}`
        })

      const transfer = (from: AccountId, to: AccountId, amount: number) =>
        sql.withTransaction(
          Effect.gen(function*() {
            yield* adjust(to, amount)
            yield* adjust(from, -amount)
          })
        ).pipe(Effect.catchTag("SqlError", Effect.die))

      return Accounts.of({
        open,
        get,
        transfer,
        richerThan: (min) => Effect.orDie(richer(min))
      })
    })
  )
}
```

读这段代码时抓住四个点。

第一，变体是派生的，而且我实际检查了：`Account.json` 编码出来的键是 `id`、`owner`、`balance`、`createdAt`、`updatedAt`，没有 `secretNote`；`Account.jsonCreate` 只有 `owner` 和 `balance`，id 和时间戳客户端根本传不进来。「内部字段不要泄漏到 API」从一个需要 review 的约定，变成了类型和 Schema 的性质。这和 HttpApi 的 payload、success 直接对接：`payload: Account.jsonCreate`、`success: Account.json` 就够了，不必再手写 DTO。

第二，`Account.insert.makeEffect` 生成 id 和时间戳，时间来自 Effect 的 Clock，按官方示例的说明，测试里可以用 TestClock 控制它，不用 mock `Date`（这一点我没有单独跑过）。

第三，错误面的划分。`get` 的接口只暴露 `AccountNotFound`：找不到是预期失败，调用方可能要返回 404。而 `SqlError` 和 `SchemaError` 用 `Effect.die` 变成 defect。我的判断标准是：**调用方能不能对这个失败做出有意义的业务恢复**。连接断了、表不存在、行数据不符合 Schema，调用方什么也做不了，只能让它冒到最外层去记录和告警。这里要提醒的是，defect 不是「吞掉」，它依然会被日志和 tracing 看见，只是不污染 service 的类型。我实际插入过一行违反 Schema 的数据（`owner` 为空字符串），用 `SqlSchema.findAll` 读出来，得到的是 typed 的 `SchemaError`，说明行解码失败不是静默的，是否降级为 defect 由你在 service 边界决定。

第四，`SqlClient` 是个普通 service，查询用 tagged template，`${min}` 是参数绑定。我编译了一条带注入串的语句看结果：文本是 `... WHERE owner = ?`，参数数组里原样放着那串带引号的恶意字符串。不需要「小心拼接」，因为这个 API 里没有拼接这个动作。

## 事务：失败、中断都会回滚

`transfer` 里我故意把顺序写成先给收款方加钱、再从付款方扣钱。付款方余额不够时，第二步才失败，此时收款方已经被加过一次钱。如果没有事务，数据就坏了。实际运行的结果：

```ts
// file: sql-demo.ts
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Accounts, SqlLive } from "./sql.js"

const Live = Accounts.layerNoDeps.pipe(Layer.provideMerge(SqlLive))

Effect.gen(function*() {
  const accounts = yield* Accounts
  const sql = yield* SqlClient.SqlClient
  const a = yield* accounts.open("alice", 100)
  const b = yield* accounts.open("bob", 10)

  const failure = yield* accounts.transfer(a.id, b.id, 500).pipe(Effect.flip)
  console.log(failure._tag, (yield* accounts.get(a.id)).balance, (yield* accounts.get(b.id)).balance)

  yield* accounts.transfer(a.id, b.id, 30)
  console.log((yield* accounts.get(a.id)).balance, (yield* accounts.get(b.id)).balance)

  yield* sql.withTransaction(
    Effect.gen(function*() {
      yield* sql`UPDATE accounts SET balance = 0`
      return yield* Effect.never
    })
  ).pipe(Effect.timeoutOption("50 millis"))
  console.log((yield* accounts.get(a.id)).balance)
}).pipe(Effect.provide(Live), Effect.runPromise)
```

输出依次是：`InsufficientFunds` 且两个余额仍是 100 和 10（回滚了）；成功转账后是 70 和 40；最后一段把 `UPDATE` 之后永远不返回的事务用 50ms 超时打断，余额仍是 70，说明**中断也会回滚**。后者是我最看重的性质：在手写 `BEGIN/COMMIT` 的世界里，超时、请求取消、进程关闭时，事务是否收尾取决于你有没有把 `finally` 写对；在这里它由 Scope 和中断机制保证，写不错。

有一个使用上的规则：事务里面只放数据库操作和纯逻辑，不要在事务中调用外部 HTTP。事务期间持有连接，外部调用的延迟会直接变成连接占用时间。如果非调不可，就先调完，再把结果带进事务。

## 驱动差异：错误分类不要想当然

`SqlError` 的 `reason` 是一个带 `_tag` 的联合，包括 `ConnectionError`、`UniqueViolation`、`ConstraintError`、`DeadlockError`、`SerializationError` 等，并且每个都有 `isRetryable`。这是比解析错误消息字符串好得多的基础：重试策略可以直接 `while: (e) => e.isRetryable`。

但我在 SQLite 上踩了一个值得记下来的细节。想把「重复插入」映射成领域错误 `OwnerTaken`，我先用 `PRIMARY KEY` 列测试，匹配 `UniqueViolation` 没命中，错误最终以 defect 冒出来，打印出来 reason 是 `ConstraintError`；换成 `UNIQUE` 约束的列，才得到 `UniqueViolation`。也就是说，**同样是「重复」，SQLite 驱动对主键冲突和唯一约束的分类不同**。

```ts
// file: uniq.ts
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

export class OwnerTaken extends Schema.TaggedError<OwnerTaken>()("OwnerTaken", { owner: Schema.String }) {}

const addOwner = (owner: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO owners (name) VALUES (${owner})`
  }).pipe(
    Effect.catchTag("SqlError", (e) =>
      e.reason._tag === "UniqueViolation" || e.reason._tag === "ConstraintError"
        ? Effect.fail(new OwnerTaken({ owner }))
        : Effect.die(e))
  )

Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE owners (name TEXT UNIQUE)`
  yield* addOwner("alice")
  const e = yield* addOwner("alice").pipe(Effect.flip)
  console.log(e._tag, e.owner)
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.runPromise)
```

这里我把两个 tag 都放行，代价是：非唯一性的约束失败（比如 `NOT NULL`）也会被当成「owner 已被占用」。这个粗糙是我明知的，我的取舍是：这张表上只有这一个唯一约束，且别的约束由 Schema 在入口拦掉了。如果你在 PostgreSQL 上，应该只匹配 `UniqueViolation`，而我没有在 PostgreSQL 上验证过它的分类，所以这条规则的更稳妥版本是：**先用真实驱动写一条重复插入的测试，看它实际落到哪个 reason，再决定匹配谁**。这个测试比任何文档都可靠。

## RPC：契约是一个共享文件

数据库的边界是行，RPC 的边界是消息。`effect/rpc` 的核心设计和 HttpApi 一样：契约是 Schema 声明，服务端和客户端读同一份。我对它的使用规则只有一条，就是**契约文件只依赖 `effect`，不依赖任何实现**，这样它可以放进一个共享包，浏览器、Worker、另一个服务都能 import，而不会把数据库驱动带过去。

```ts
// file: contract.ts
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()("TodoNotFound", { id: Schema.Int }) {}

export class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.Int,
  title: Schema.String,
  done: Schema.Boolean
}) {}

export class TodoRpcs extends RpcGroup.make(
  Rpc.make("GetTodo", {
    payload: { id: Schema.Int },
    success: Todo,
    error: TodoNotFound
  }),
  Rpc.make("CreateTodo", {
    payload: { title: Schema.NonEmptyString },
    success: Todo
  }),
  Rpc.make("WatchTodos", {
    success: Todo,
    stream: true
  })
) {}
```

这里每个 Rpc 有 payload、success、error 三个槽。没写 `error` 的，错误通道就是 `Never`，也就是该调用在业务上不会失败；`stream: true` 把 success 包成 Stream。

服务端实现用 `toLayer`，得到的是一个提供「handler」的 Layer：

```ts
// file: rpc-server.ts
import { Effect, Layer, Ref, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Todo, TodoNotFound, TodoRpcs } from "./contract.js"

export const TodoHandlers = TodoRpcs.toLayer(
  Effect.gen(function*() {
    const store = yield* Ref.make<ReadonlyArray<Todo>>([new Todo({ id: 1, title: "write", done: false })])
    return TodoRpcs.of({
      GetTodo: ({ id }) =>
        Ref.get(store).pipe(
          Effect.flatMap((all) => {
            const t = all.find((x) => x.id === id)
            return t ? Effect.succeed(t) : Effect.fail(new TodoNotFound({ id }))
          })
        ),
      CreateTodo: ({ title }) =>
        Ref.modify(store, (all) => {
          const t = new Todo({ id: all.length + 1, title, done: false })
          return [t, [...all, t]]
        }),
      WatchTodos: () => Stream.fromIterableEffect(Ref.get(store))
    })
  })
)

export const RpcRoutes = RpcServer.layerHttp({ group: TodoRpcs, path: "/rpc", protocol: "http" }).pipe(
  Layer.provide(TodoHandlers),
  Layer.provide(RpcSerialization.layerNdjson)
)

export const Serve = HttpRouter.serve(RpcRoutes)
```

`TodoRpcs.of` 让 handler 的形状被契约约束，写错返回类型会编译失败。更有意思的是**漏实现**：我试过把 `Layer.provide(TodoHandlers)` 拿掉，错误不是运行时才有的「找不到 handler」，而是 `Layer` 的环境里留下了 `Handler<"GetTodo">`、`Handler<"CreateTodo">`、`Handler<"WatchTodos">` 这三个未满足的依赖，编译就停在启动入口。给契约加一个新 Rpc，所有服务端实现都必须跟着补，否则编译不过。这是 Layer 依赖追踪在契约上的直接收益。

客户端一侧，传输由一个 Protocol Layer 决定：

```ts
// file: rpc-client.ts
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { createServer } from "node:http"
import { TodoNotFound, TodoRpcs } from "./contract.js"
import { Serve } from "./rpc-server.js"

const ClientProtocol = RpcClient.layerProtocolHttp({ url: "http://localhost:3457/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(FetchHttpClient.layer)
)

const useClient = Effect.gen(function*() {
  const client = yield* RpcClient.make(TodoRpcs)
  console.log(yield* client.GetTodo({ id: 1 }))

  const err = yield* client.GetTodo({ id: 42 }).pipe(
    Effect.catchTags({
      TodoNotFound: (e) => Effect.succeed(e),
      RpcClientError: (e) => Effect.die(e)
    })
  )
  console.log(err instanceof TodoNotFound)

  console.log(yield* Stream.runCollect(client.WatchTodos()))
})

const Server = Serve.pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 3457 })))

await Effect.scoped(
  Layer.build(Server).pipe(Effect.andThen(useClient.pipe(Effect.provide(ClientProtocol))))
).pipe(Effect.runPromise)
```

这段我用真实的 Node 服务端和 `FetchHttpClient` 跑过。几个观察：

- `GetTodo({ id: 42 })` 的错误通道是 `TodoNotFound | RpcClientError`。**前者是契约里声明的业务错误，后者是传输层的失败**，两者被分在同一个通道里但 `_tag` 不同，所以 `catchTags` 能分别处理。运行的结果里 `TodoNotFound` 是真正的类实例，字段完整，`instanceof` 成立，不是一个丢了类型的普通对象。
- 我把客户端指向一个没有服务的端口，得到的是 `RpcClientError`，其 `reason._tag` 是 `HttpError`。也就是说，网络不通在类型里是显式的，你必须决定怎么处理。
- `WatchTodos()` 在客户端是一个 `Stream`，用 `Stream.runCollect` 能拿到全部元素。取消、背压、重试和普通 Stream 一致。
- 一个我没预料到的行为：用空字符串调用 `CreateTodo`（违反 `NonEmptyString`），结果不是错误通道里的值，而是 defect（Cause 里是 Die，带 Schema 校验失败的信息）。我的理解是，payload 不合法属于调用方的编程错误，契约里没有给它留位置。如果你需要把「用户输入不合法」当成可恢复的业务错误，就应该在契约里显式声明一个 `error`，并在 handler 里自己校验，而不是依赖 payload 的 Schema 去拦截。

传输是可替换的：这个 `ClientProtocol` 换成 Socket 或 Worker 版本（`RpcClient.layerProtocolSocket`、`layerProtocolWorker`，服务端对应 `RpcServer.layerProtocolWebsocket` 等），契约和业务代码都不变。我只验证了 HTTP 这一种，其余的只是确认它们在包里存在，没有跑过。

## 测试：契约自带内存传输

最后是测试。`RpcTest.makeClient` 把客户端直接接到服务端 handler 上，不经过任何序列化和网络：

```ts
// file: rpc-test.ts
import { Effect } from "effect"
import { RpcTest } from "effect/rpc"
import { TodoRpcs } from "./contract.js"
import { TodoHandlers } from "./rpc-server.js"

await Effect.scoped(
  Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(TodoRpcs)
    console.log(yield* client.GetTodo({ id: 1 }))
  })
).pipe(Effect.provide(TodoHandlers), Effect.runPromise)
```

它要求环境里有 handler 的 Layer，这与生产环境一致，所以测试的是真正的业务 handler，只是少了一层传输。我的建议是：业务逻辑用这种内存方式测，序列化与传输用一两个端到端用例覆盖。

## 小结

1. 数据模型只写一份字段声明，用 `Model.Class` 派生 select、insert、update 和 json 系列变体，内部字段不泄漏是性质而不是约定。
2. `SqlClient` 的 tagged template 天然参数化；`SqlSchema` 与 Model 负责行的解码，`SchemaError` 是 typed 的。
3. service 边界上，可恢复的业务失败进入 E，`SqlError`、`SchemaError` 这类基础设施失败用 `die`，判断标准是调用方能不能做出业务恢复。
4. `withTransaction` 在失败和中断时都回滚；不要在事务里调用外部服务。
5. `SqlError.reason` 的分类依赖驱动：我在 SQLite 上看到主键冲突是 `ConstraintError`、唯一约束才是 `UniqueViolation`，写映射前先用真实驱动写一条测试。
6. RPC 契约放进只依赖 `effect` 的共享文件；客户端错误通道里业务错误和 `RpcClientError` 并存；漏实现 handler 是编译错误；传输通过 Layer 替换，测试用 `RpcTest` 的内存传输。

到这里，进程内的错误、服务、Schema，到进程外的 HTTP、数据库、RPC，用的是同一套东西：在边界解码，把预期失败写进类型，把运行时差异关进 Layer。
