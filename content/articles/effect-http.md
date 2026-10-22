---
title: "Effect 的 HTTP：把状态码、超时和运行时差异都写进类型"
description: 用 effect/http 的 HttpClient 把传输、状态码、解码与超时放进错误通道，用 HttpApi 一份定义同时得到服务端、客户端和文档，再用 toWebHandler 接到 Workers 这类 fetch 运行时。
date: 2026-10-08
category: effect
tags: [effect, guide]
---

前面几篇讲的都是进程内的东西：错误、服务、Layer、边界解码、并发。HTTP 是这些东西第一次真正碰到外部世界的地方，也是「失败」最丰富的地方：连不上、超时、返回 503、返回 200 但 body 不对、路径参数是 `abc`。这一篇我想回答一个问题：怎么让这些失败都出现在类型里，而不是散落在 `try/catch` 和 `res.ok` 判断里。

先交代一个和旧资料不一致的事实。如果你读过 v3 时代的文档，会习惯 `@effect/platform` 里的 `HttpClient`、`HttpApi`。在 effect 4.0.5 里这些模块已经并入 `effect` 本体，路径是 `effect/http` 和 `effect/http-api`，只有 Node 这类运行时适配（比如 `@effect/platform-node`）还是独立包。另外这些模块的文档标注是 unstable，小版本之间 API 可能调整，所以后面我会尽量把依赖面收窄到少数几个函数。

## 一次 HTTP 调用有四种失败

我习惯把一次出站调用拆成四个层次，每一层对应一种不同的错误，也对应不同的处理策略：

- 传输失败：DNS、连接被拒、连接中断。通常值得重试。
- 状态码失败：服务端明确说了「不行」。5xx、429 值得重试，404 和 400 不值得。
- 解码失败：状态码是 2xx，但 body 不符合你期望的形状。重试没用，这是契约被破坏。
- 超时：以上任何一层都可能卡住，需要一个由你来决定的上限。

前三层 `HttpClient` 已经替你分好了：它的错误通道是 `HttpClientError`，里面的 `reason` 是带 `_tag` 的联合，`TransportError`、`StatusCodeError`、`DecodeError` 等等一目了然。解码失败来自 Schema，是 `SchemaError`。超时来自 `Effect.timeout`，是 `TimeoutError`。四种东西各有各的 `_tag`，所以可以用上一篇的 `catchTags` 一次分流。

## HttpClient 是一个 service，中间件是值

下面是完整的一个出站服务。关键的设计是：`HttpClient` 本身是个普通的 service，你从环境里取出来，用 `mapRequest`、`filterStatusOk`、`retryTransient` 这些组合子一层层包上去，得到一个新的 client。这些包装全是纯值的变换，不触发任何请求。

```ts
// file: client.ts
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export class User extends Schema.Class<User>("User")({
  id: Schema.Int,
  name: Schema.String
}) {}

export class UserServiceError extends Schema.TaggedError<UserServiceError>()("UserServiceError", {
  kind: Schema.Literals(["Unavailable", "Timeout", "BadResponse", "NotFound"]),
  cause: Schema.optional(Schema.Defect())
}) {}

export class Users extends Context.Service<Users, {
  getById(id: number): Effect.Effect<User, UserServiceError>
}>()("app/Users") {
  static readonly layerNoDeps = Layer.effect(
    Users,
    Effect.gen(function*() {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("https://users.internal")),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
      )

      const getById = Effect.fn("Users.getById")(function*(id: number) {
        return yield* client.get(`/users/${id}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(User)),
          Effect.timeout("2 seconds"),
          Effect.catchTags({
            TimeoutError: (cause) => Effect.fail(new UserServiceError({ kind: "Timeout", cause })),
            SchemaError: (cause) => Effect.fail(new UserServiceError({ kind: "BadResponse", cause })),
            HttpClientError: (e) =>
              Effect.fail(
                new UserServiceError({
                  kind: e.reason._tag === "StatusCodeError" && e.reason.response.status === 404
                    ? "NotFound"
                    : "Unavailable",
                  cause: e
                })
              )
          })
        )
      })

      return Users.of({ getById })
    })
  )

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer))
}
```

这段代码有几处是我刻意做的取舍，值得单独说。

第一，`filterStatusOk` 把非 2xx 变成 `StatusCodeError`。不加它，404 会作为「成功」的 Response 流下去，然后在 Schema 解码处以一个误导性的 `SchemaError` 爆出来。**状态码判断必须在解码之前、在 client 层统一做**，而不是每个调用点自己写 `if (res.status !== 200)`。

第二，`retryTransient` 只重试「看起来是暂时性」的失败：传输错误和 5xx、429 这类响应。我实际跑过：404 只发了 1 次请求，连续 503 发了 4 次（1 次加 3 次重试），解码失败也只发 1 次。你不需要自己写 `while` 谓词去区分，默认值已经符合「重试只对暂时性失败有意义」这个判断标准。

第三，也是最重要的：**`HttpClientError` 不应该跨过 service 边界**。调用方关心的是「用户服务不可用」，而不是「第三层 StatusCodeError」。所以在 service 内部把四种失败折叠成一个带 `kind` 的领域错误。`kind` 用字面量联合而不是四个错误类，是因为调用方通常只需要决定「要不要降级」，不需要四条不同的恢复路径；如果某一种需要独立恢复，再把它升格成独立的 TaggedError 就行，这是一个随需求移动的边界。

第四，`layerNoDeps` 和 `layer` 分成两个。前者只依赖抽象的 `HttpClient`，后者才绑定 `FetchHttpClient`。这个拆分是为了测试，下一节会用到。

## 超时放在哪里，决定了它在限制什么

`Effect.timeout` 是一个包在 effect 外面的组合子，所以它放在重试的里面还是外面，语义完全不同。上面的例子里，`retryTransient` 已经包在 client 里，`Effect.timeout("2 seconds")` 包在整个调用外面，于是 2 秒是**含全部重试在内的总预算**。我用一个总是返回 503 的假 client 验证过：

```ts
// file: order.ts
import { Effect, Schedule } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

let calls = 0
const base = HttpClient.make((request) => {
  calls++
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("x", { status: 503 })))
})

const client = base.pipe(
  HttpClient.filterStatusOk,
  HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
)

Effect.gen(function*() {
  const exit = yield* Effect.exit(client.get("http://x/").pipe(Effect.timeout(250)))
  console.log(calls, exit._tag)
}).pipe(Effect.runPromise)
```

退避从 100ms 开始，第二次请求在约 100ms 发出，第三次要等到约 300ms，而总超时 250ms 先到，结果是只发了 2 次请求，失败是 `TimeoutError`。

如果你想要的是「每次尝试最多 2 秒」，就得把 `Effect.timeout` 放进 retry 里面，也就是自己控制重试。我的建议是默认用总预算：它对应上游调用方真正等待的时间，也不会因为重试次数调大而悄悄放大最坏延迟。需要每次尝试的限制时，要显式写出来并在注释里说明，因为这两种写法在代码上只差一个括号的位置。

## 测试：换掉 HttpClient，不开网络

`HttpClient.make` 接受一个函数，返回 `HttpClient`。这就是测试替身。因为上一节把依赖拆到了 `layerNoDeps`，测试里只要给它一个假的 `HttpClient` 层：

```ts
// file: fake.ts
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Users } from "./client.js"

let calls = 0
const Fake = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request) => {
    calls++
    const body = calls < 3 ? new Response("{}", { status: 503 }) : Response.json({ id: 1, name: "a" })
    return Effect.succeed(HttpClientResponse.fromWeb(request, body))
  })
)

Effect.gen(function*() {
  const users = yield* Users
  console.log(yield* users.getById(1), calls)
}).pipe(Effect.provide(Users.layerNoDeps.pipe(Layer.provide(Fake))), Effect.runPromise)
```

这个例子里两次 503 之后成功，实际输出是第 3 次请求拿到结果。我用同样的方式覆盖了其余路径，结果和上面的判断一致：404 映射成 `NotFound`，连接失败重试 3 次后是 `Unavailable`，body 形状不对是 `BadResponse`，一个永远不返回的请求在 2 秒时变成 `Timeout`。每一种失败都是一个可断言的值，这就是把失败写进类型的实际收益。

## HttpApi：一份定义，三个消费者

出站讲完看入站。`HttpApi` 的立场是：接口契约是一份 Schema 驱动的声明，服务端实现、类型化客户端、OpenAPI 文档都从它派生。这里有一条我认为是硬约束的不变量：**定义文件不能 import 任何服务端实现**，否则客户端打包时会把服务端代码带进去。所以定义单独成文件。

```ts
// file: api.ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.Int },
  { httpApiStatus: 404 }
) {}

export class UpstreamTimeout extends Schema.TaggedError<UpstreamTimeout>()(
  "UpstreamTimeout",
  {},
  { httpApiStatus: 504 }
) {}

export class UserView extends Schema.Class<UserView>("UserView")({
  id: Schema.Int,
  name: Schema.String
}) {}

export class UsersGroup extends HttpApiGroup.make("users").add(
  HttpApiEndpoint.get("getById", "/users/:id", {
    params: { id: Schema.Int },
    success: UserView,
    error: [UserNotFound, UpstreamTimeout]
  }),
  HttpApiEndpoint.post("create", "/users", {
    payload: Schema.Struct({ name: Schema.NonEmptyString }),
    success: UserView
  })
) {}

export class Api extends HttpApi.make("app").add(UsersGroup) {}
```

注意两件事。一是错误类直接带状态码：`{ httpApiStatus: 404 }` 作为 `TaggedError` 的第三个参数，状态码和错误是同一个事实，只写在一处。二是**超时在这里是契约的一部分**：`UpstreamTimeout` 显式出现在 `error` 列表里，对应 504。调用方在类型里就能看到「这个接口可能超时」，而不是靠运行时的一个 500 去猜。

实现这边，handler 的返回类型被端点定义约束：失败只能是声明过的错误，写一个没声明的错误类型会编译失败。

```ts
// file: server.ts
import { Effect, Layer, Ref } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api, UpstreamTimeout, UserNotFound, UserView } from "./api.js"

export const UsersHandlers = HttpApiBuilder.group(
  Api,
  "users",
  Effect.fn(function*(handlers) {
    const store = yield* Ref.make(new Map<number, UserView>([[1, new UserView({ id: 1, name: "alice" })]]))
    return handlers
      .handle("getById", ({ params }) =>
        Effect.gen(function*() {
          const user = (yield* Ref.get(store)).get(params.id)
          if (user === undefined) return yield* new UserNotFound({ id: params.id })
          if (user.name === "slow") {
            yield* Effect.never.pipe(Effect.timeout("50 millis"), Effect.mapError(() => new UpstreamTimeout()))
          }
          return user
        }))
      .handle("create", ({ payload }) =>
        Ref.modify(store, (m) => {
          const user = new UserView({ id: m.size + 1, name: payload.name })
          return [user, new Map(m).set(user.id, user)]
        }))
  })
)

export const AppRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(UsersHandlers))

export const web = HttpRouter.toWebHandler(AppRoutes.pipe(Layer.provide(HttpServer.layerServices)))
```

`handle` 拿到的 `params` 和 `payload` 已经是解码后的值，`params.id` 是 `number` 而不是字符串。解码失败根本不会进入 handler：我实测 `/users/abc` 返回 400，`name` 为空的 POST 也是 400，没有声明的路由是 404，都不需要你写一行校验代码。这正是上一篇「边界解码」在服务端的落点。

## 派生客户端：契约变更变成编译错误

同一份 `Api` 可以直接生成客户端，错误通道里就是你声明过的 `UserNotFound`：

```ts
// file: serve.ts
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { createServer } from "node:http"
import { Api } from "./api.js"
import { AppRoutes } from "./server.js"

const Server = HttpRouter.serve(AppRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3456 }))
)

const program = Effect.gen(function*() {
  const client = yield* HttpApiClient.make(Api, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost:3456"))
  })
  const ok = yield* client.users.getById({ params: { id: 1 } })
  const err = yield* client.users.getById({ params: { id: 7 } }).pipe(Effect.flip)
  console.log(ok, err._tag, err instanceof Error)
}).pipe(Effect.provide(FetchHttpClient.layer))

await Effect.scoped(Layer.build(Server).pipe(Effect.andThen(program))).pipe(Effect.runPromise)
```

我实际起了一个 Node 服务再用这个客户端调用，`getById` 对 id 7 得到的是 `UserNotFound` 这个类的实例，`_tag` 和字段都保留，不是一个只有状态码的通用异常。这里服务端的错误、传输的 JSON、客户端的错误是同一个 Schema 的两端，这是 `HttpApi` 相对于「手写路由加手写 fetch」的根本差别：两边无法漂移。

线上你会用 `Layer.launch` 配 `NodeRuntime.runMain` 来启动，这一部分和前面几篇讲的运行时边界一致，这里为了能在脚本里自己收尾，用的是 `Layer.build` 加 scope。

## 接到 Cloudflare Workers：fetch 就是一个函数

Workers 的入口是一个 `fetch(request, env)` 函数。`HttpRouter.toWebHandler` 恰好产出 `Request -> Promise<Response>`，所以接合点非常薄。有一个设计值得注意：运行时给你的 `env`（KV、D1、secret 之类的 bindings）不应该被业务代码直接读，应该先包成一个 service。

```ts
// file: worker.ts
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"

export class Bindings extends Context.Service<Bindings, { readonly GREETING: string }>()("app/Bindings") {}

const Hello = HttpRouter.add(
  "GET",
  "/hello",
  Effect.gen(function*() {
    const { GREETING } = yield* Bindings
    return HttpServerResponse.text(GREETING)
  })
)

export const app = HttpRouter.toWebHandler(Hello.pipe(Layer.provide(HttpServer.layerServices)), {
  disableLogger: true
})

export default {
  fetch: (request: Request, env: { readonly GREETING: string }) =>
    app.handler(request, Context.make(Bindings, env))
}
```

这里有个我踩到的类型细节：路由里依赖的 `Bindings` 没法通过 `Layer.provide` 消掉，因为它是**请求级**依赖，会变成 `handler` 的第二个参数。我最初只传了一个参数，编译器报「期望 2 个参数」。这其实是好事：如果你忘了把 `env` 传进去，是编译错误，不是线上某个请求才发现的 undefined。

构建时机上要注意官方文档里的提醒：在 Workers 上，`toWebHandler` 应该在模块作用域构建一次，不要放进 `fetch` 里，因为在 `fetch` 内启动的 fiber 会捕获那次请求的异步上下文；也不要依赖无限期的后台 fiber。上面的例子遵守了这一点：`app` 在模块顶层创建，`fetch` 里只做转发。

诚实地说一下验证范围：我没有部署到真实的 workerd。验证做到了「按 Workers 的形状调用」，即用标准的 `Request` 调用 `worker.fetch`，`/hello` 得到 200 和配置的文本，未知路径得到 404。runtime 特有的行为（bindings 的真实形态、请求上下文的生命周期）我只能引用文档，不能替你担保。同一个 `AppRoutes` 在 Node 上用 `HttpRouter.serve` 加 `NodeHttpServer.layer` 启动，在 Workers 上用 `toWebHandler`，路由和 handler 一行不改，差异只在最外层的几行接合代码。这是 Layer 作为运行时边界的典型收益。

## 小结

HTTP 层的核心经验可以压成几条：

1. 出站调用有传输、状态码、解码、超时四种失败，分别对应 `HttpClientError.reason`、`SchemaError`、`TimeoutError`，把它们放在错误通道里，用 `catchTags` 分流。
2. 状态码用 `filterStatusOk` 在 client 层统一判断，重试交给 `retryTransient`，不要在调用点手写。
3. `Effect.timeout` 的位置决定它限制的是总预算还是单次尝试，默认用总预算。
4. `HttpClientError` 在 service 边界折叠成领域错误；依赖拆成 `layerNoDeps` 和 `layer`，测试时直接换掉 `HttpClient`。
5. `HttpApi` 的定义文件不依赖实现；错误类自带状态码，超时也写进契约。
6. 运行时接合只在最外层：Node 用 `HttpRouter.serve`，Workers 用 `toWebHandler`，bindings 先包成 service。

下一篇讲数据库和 RPC，它们是同一个思路的另外两个边界：行和消息也是外部世界的数据，也要在入口处解码，并且把失败的形状写进类型。
