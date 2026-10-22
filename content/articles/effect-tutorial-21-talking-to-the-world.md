---
title: "与外部世界对话：HttpClient、SQL、RPC 的共同形状"
description: HTTP、数据库、RPC 看似三个领域，其实都是跨进程边界的调用，面对同样的问题。本章讲它们共享的形状，以及 HttpClient、SqlClient、Rpc 怎样落在这个形状上。
date: 2026-10-20
tags: [effect, tutorial, http, sql, rpc, boundary]
category: effect
series: effect-tutorial
seriesOrder: 21
---

前面 20 章讲的东西，大多发生在进程内部。这一章讲程序和外部世界对话的时候：调用别的服务的 HTTP 接口，查数据库，或者调用另一个服务的 RPC。

我不打算把三个模块各讲一遍 API。它们的细节在文末的深挖文章里。这一章想让你看到的是：它们是同一件事的三种外观，学会一个，另外两个的使用方式基本就能预判。

## 要解决的问题

不管是 HTTP、SQL 还是 RPC，一次调用都意味着：把一份数据从你的进程送到另一个进程，再把对方的回答收回来。这件事天然面对四个问题。

- **回来的数据不可信**。第 7 章讲过，TypeScript 类型在运行时不存在。对方返回的 JSON、数据库返回的行、RPC 的响应，都只是「看起来像」你期望的形状。
- **失败的种类很多**。连不上，超时，对方明确拒绝，对方返回了但内容不对，业务上的「找不到」。这些失败的处理方式完全不同。
- **会变慢或卡住**。网络不会替你设置上限。没有超时的调用，就是一个潜在的永久挂起。
- **会占用有限的资源**。连接、连接池、事务。用完不释放，就会泄漏。

## 朴素做法为什么不够

朴素做法是 `fetch(...).then(r => r.json())`，或者 `db.query(sql)`，然后把结果断言成某个类型。

- `r.json()` 返回 `any`，一个 `as User` 就把「相信」写进了类型里，错了也不知道，直到下游某处崩溃。
- `fetch` 只在网络层失败时 reject，404 和 500 照样 resolve。要靠手写 `if (!r.ok)`，漏一次就把错误页当成数据解析。
- 失败都是 `catch (e)` 里的 `unknown`，你分不清哪个是该重试的传输抖动，哪个是不该重试的业务拒绝。
- 超时要手写 `AbortController`，事务要手写 `BEGIN`、`COMMIT`、`ROLLBACK` 并在每条异常路径上记得回滚。

这些都是第 1 章说过的三件看不见的事（错误、依赖、取消）的具体表现，只是发生在边界上。

## Effect 的做法与心智模型

三个模块共享同一个形状。我把它拆成五条，每一条都对应前面某一章：

1. **契约用 Schema 写**（第 7、8 章）。请求怎么编码，响应怎么解码，都由 Schema 声明。解码失败是一个类型化的失败，而不是之后才爆炸的坏数据。
2. **失败分层，各归其位**（第 5、6 章）。传输失败、状态码失败、解码失败、业务失败，是不同类型，在错误通道里能区分。
3. **客户端是一个 service，不是全局函数**（第 9 章）。你的业务代码依赖「一个能获取用户的服务」，而不是依赖 `fetch`。
4. **传输的装配放在 Layer 里**（第 10 章）。用 `FetchHttpClient`、某个 SQL 驱动、某个 RPC 协议，都是换一个 Layer 的事。连接池的生命周期由 Layer 的 Scope 管（第 15 章）。
5. **超时、重试、span 作为组合子叠上去**（第 16、20 章）。它们不改变调用本身，只是包在外面。

换句话说：外部调用不是特殊的东西，它只是一个**类型化失败更多、需要 Schema 更严格、需要 Layer 管资源**的普通 Effect。

### HttpClient：从取出 service 开始

`HttpClient` 本身是个 service。你在 Effect 里 `yield*` 取出它，用一系列组合子包装成你需要的客户端，包装本身是纯值变换，不会发请求。几个典型的组合子：`HttpClient.mapRequest` 改请求（比如加前缀 URL、加 Accept 头），`HttpClient.filterStatusOk` 把非 2xx 响应变成失败，`HttpClient.retryTransient` 对暂时性失败自动重试。响应体用 `HttpClientResponse.schemaBodyJson(Schema)` 解码。

```ts
import { Context, Data, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

class User extends Schema.Class<User>("User")({
  id: Schema.Int,
  name: Schema.String
}) {}

class UserServiceError extends Data.TaggedError("UserServiceError")<{
  readonly kind: "Unavailable" | "Timeout" | "BadResponse"
}> {}

class Users extends Context.Service<Users, {
  getById(id: number): Effect.Effect<User, UserServiceError>
}>()("app/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("https://users.internal")),
        HttpClient.filterStatusOk
      )
      return Users.of({
        getById: (id) =>
          client.get(`/users/${id}`).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(User)),
            Effect.timeout("2 seconds"),
            Effect.catchTags({
              TimeoutError: () => Effect.fail(new UserServiceError({ kind: "Timeout" })),
              SchemaError: () => Effect.fail(new UserServiceError({ kind: "BadResponse" })),
              HttpClientError: () => Effect.fail(new UserServiceError({ kind: "Unavailable" }))
            })
          )
      })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
```

读这段代码的方式，是对照五条。`User` 是契约；超时、解码失败、传输和状态码失败，是三种不同的错误来源，在最后被翻译成**调用方关心的**一个错误类型 `UserServiceError`（第 6 章的「在边界翻译」）；这个错误只在进程内流动，所以按第 5 章的口径用 `Data.TaggedError`；`Users` 是 service，业务代码只依赖它的接口；`FetchHttpClient.layer` 是传输的装配；`Effect.timeout` 是叠上去的超时。

### SQL：同样的形状，不同的传输

数据库调用换了个词汇，形状不变。`SqlClient.SqlClient` 是 service，用它的模板字符串写查询。`SqlSchema.findOne` 一类的函数把「请求怎么编码、结果怎么解码」绑到一起：入参用 Schema 编码，返回的行用 Schema 解码。事务用 `sql.withTransaction(effect)` 包住一段 Effect，成功则提交，失败或中断则回滚，不用手写异常路径。

```ts
import { Effect, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"

class Account extends Schema.Class<Account>("Account")({
  id: Schema.String,
  balance: Schema.Int
}) {}

export const makeAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const findById = SqlSchema.findOne({
    Request: Schema.String,
    Result: Account,
    execute: (id) => sql`SELECT id, balance FROM accounts WHERE id = ${id}`
  })

  const debit = (id: string, amount: number) =>
    sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${id}`

  const transfer = (from: string, to: string, amount: number) =>
    Effect.gen(function* () {
      yield* debit(from, amount)
      yield* sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`
    }).pipe(sql.withTransaction)

  return { findById, transfer } as const
})
```

对照五条：行经过 `Account` 解码，库里的脏数据会在这里变成 `SchemaError`；SQL 的失败是类型化的 `SqlError`，而 `findOne` 查不到时是 `NoSuchElementError`，你再翻译成自己的「账户不存在」；驱动是 Layer（SQLite、PostgreSQL 等各有各的包），业务代码一行不用改；`withTransaction` 之所以可靠，是因为它建立在第 15 章的资源安全之上，回滚就是一个 finalizer。

### RPC：契约共享，两端对称

RPC 比前两者多一个特点：**契约是两端共享的**。你先写一份契约文件，用 `Rpc.make` 声明每个调用的名字、payload、成功类型和错误类型，用 `RpcGroup.make` 把它们归成一组。服务端据此实现处理函数，客户端据此得到一个类型完整的调用接口。两端用的是同一份 Schema，所以请求或响应的任何一方悄悄变了形状，在编译期和解码期都会暴露。

```ts
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

class User extends Schema.Class<User>("User")({
  id: Schema.String,
  name: Schema.String
}) {}

class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: Schema.String
}) {}

export const UserRpcs = RpcGroup.make(
  Rpc.make("GetUser", {
    payload: { id: Schema.String },
    success: User,
    error: UserNotFound
  })
)
```

这里的 `error` 是一个 Schema（所以错误类要用第 5 章说的 `Schema.TaggedError`，这是它真正派上用场的地方），意味着**业务失败是契约的一部分**，会被编码后跨网络传回，客户端拿到的仍然是类型化的 `UserNotFound`。而「连接断了」这类传输失败是另外的错误类型（客户端的 `RpcClientError`），不会和业务失败混在一起。这正好是前面第 2 条「失败分层」。传输方式同样是 Layer：同一份契约，可以挂在 HTTP、WebSocket、Worker 等不同协议之上。

### 共同点放在一起看

把三个例子并排看，变化的只有词汇：

- 契约：HTTP 的响应 Schema，SQL 的 Request 与 Result Schema，RPC 的 payload、success、error Schema。
- 传输：`FetchHttpClient`，SQL 驱动，RPC 协议；都是 Layer。
- 失败：传输类、解码类、业务类，各有各的位置。

这就是「同一个生成器」：不是三个要分别记忆的模块，而是同一个形状在三个领域里的实例。

## 常见误区

- **把 Schema 解码省掉**。`as User` 是在把不可信数据当作可信。每一条出入边界的数据，都应该有一次解码。
- **所有失败都用同一种方式重试**。传输抖动、5xx、429 可以重试，404、400、解码失败不该重试。重试之前先分类（第 6 章）。
- **把底层错误原样泄漏给业务层**。业务层不该认识 `HttpClientError` 或 `SqlError`。在 service 的边界把它们翻译成调用方关心的错误，底层的作为 `cause` 保留。
- **没有超时**。外部调用没有上限，就是一个潜在的永久挂起。超时的值要写出来，而不是依赖默认。
- **在事务里做慢的外部调用**。事务占着连接和锁，里面再去调另一个 HTTP，会把数据库的容量拖垮。事务里只放数据库操作。
- **客户端不是 service**。业务函数里直接 `fetch`，测试时没法替换，依赖也看不见。第 12 章的替身 Layer 在这里最有用：把 `Users` 换成一个返回固定数据的实现，测试就不需要网络。
- **忽略这些模块的稳定性**。`effect/http`、`effect/sql`、`effect/rpc` 这些模块在 4.0.5 里标注为 unstable，小版本之间 API 可能变动。把对它们的依赖收在少数几个适配文件里，换版本时只需要改那几处。第 22 章会再讲版本与 unstable 的管理。

## 小结

跨进程的调用，不管叫 HTTP、SQL 还是 RPC，都是：用 Schema 写契约，把失败分层，让客户端成为 service，把传输放进 Layer，把超时重试和观测叠在外面。前 20 章的东西没有变，只是在边界上用得更加密集。

到这里，你已经具备了写出一个完整 Effect 程序所需要的全部概念。接下来的第六部分不再引入新概念，而是讲治理：怎样用约定和机械检查让一个团队长期把 Effect 用对，以及怎样管理版本和 unstable 模块。

## 延伸阅读

- [Effect 的 HTTP：把状态码、超时和运行时差异都写进类型](/articles/effect-http)
- [Effect 的 SQL 与 RPC：Schema 驱动的数据模型、事务与共享契约](/articles/effect-sql-and-rpc)
- [Effect Schema：在系统边界做解码，一份定义多处使用](/articles/effect-schema-at-the-boundary)
- [Effect 重试与 Schedule：退避、抖动、repeat、超时与限流](/articles/effect-retry-and-schedule)
