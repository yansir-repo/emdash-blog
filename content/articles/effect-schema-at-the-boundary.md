---
title: "Effect Schema：在系统边界做解码，一份定义多处使用"
description: "用 Effect v4 的 Schema 在系统边界解码未知数据：定义 Schema、拿到类型化的 SchemaError、累积全部字段错误，并让 TypeScript 类型、编码格式与校验逻辑都来自同一份定义。"
date: 2026-10-21
tags: [effect, typescript, schema]
category: effect
---

TypeScript 的类型在运行时不存在。`JSON.parse` 返回的是 `any`，`req.body` 是 `unknown`，环境变量是 `string | undefined`。很多项目的"类型安全"其实停在边界之内：边界上一句 `as User`，之后所有代码都在相信一个没人验证过的谎言。

Effect 的 `Schema` 解决的是这个边界问题：**数据进入系统时解码一次，通过的就是真类型，失败的变成类型化错误。**这篇文章里的代码我都在 strict 模式下编译并运行过。

## v3 到 v4：API 改动不小

Schema 是 v3 到 v4 变化最大的模块之一，凭 v3 记忆写会直接编译失败。我核对过的几处：

- `Schema.decodeUnknown` 变成 `Schema.decodeUnknownEffect`，同步版 `decodeUnknownSync` 保留。
- 解码失败的错误从 `ParseError` 变成 `SchemaError`，`_tag` 是 `"SchemaError"`，里面的 `issue` 是结构化的错误树。
- 带 tag 的 Schema 错误类仍是 `Schema.TaggedError`，写法是 `Schema.TaggedError<Self>()(tag, fields)`（beta 早期曾叫 `TaggedErrorClass`，4.0.5 里已不存在）。
- 校验改成统一的 `.check(...)`：`Schema.pattern`、`Schema.int()` 这类写法换成 `Schema.isPattern`、`Schema.Int`、`Schema.isBetween` 配合 `check`。
- `Schema.Literal("a", "b")` 变成 `Schema.Literals(["a", "b"])`，`Schema.Union(a, b)` 变成 `Schema.Union([a, b])`。
- 表示"键可以不存在"用 `Schema.optionalKey`；`Schema.optional` 在 v4 里语义不同，它还会接受值为 `undefined` 的情况，别再无脑沿用 v3 的习惯。
- 取类型从 `Schema.Schema.Type<typeof S>` 变成直接 `typeof S.Type` 与 `typeof S.Encoded`。

## 为什么要在边界解码

校验分散在业务代码里有两个问题。一是遗漏：十个调用点里总有一个忘了检查。二是重复：同一个字段在 controller、service、repository 各验证一遍，规则还会慢慢不一致。

边界解码把这件事收敛成一个入口。进来之前是 `unknown`，进来之后是具体类型，中间只经过一个函数。类型系统会替你保证"没解码的数据过不了关"，因为只有 Schema 能产出 `CreateUser`，而你手写的对象字面量要么类型对不上，要么得靠 `as` 强行绕过，后者在代码评审里一眼就能看出来。

## 一份定义

先看一个创建用户的请求体：

```ts
import { Context, Data, Effect, Layer, Schema, SchemaIssue } from "effect"

const Email = Schema.String.check(
  Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
).pipe(Schema.brand("Email"))

const CreateUser = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Email,
  age: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 150 })),
  role: Schema.Literals(["admin", "member"]),
  nickname: Schema.optionalKey(Schema.String),
})

type CreateUser = typeof CreateUser.Type
type CreateUserWire = typeof CreateUser.Encoded

const sendWelcome = (email: typeof Email.Type): string => `welcome ${email}`
```

这一份 `CreateUser` 同时承担了：

- **运行时校验**：非空、邮箱格式、整数范围、枚举。
- **静态类型**：`CreateUser` 类型直接从 Schema 推出来，不需要再手写 `interface`。
- **编码态类型**：`CreateUserWire` 描述数据在线上的样子。这里两者一样，下一节会看到不同的情况。
- **名义类型**：`Email` 被 `brand` 之后，普通 `string` 不能直接传给 `sendWelcome`，只有解码过的才行。

这就是"同源"的意思：不会出现 zod 一份、`interface` 一份、数据库类型一份，然后三份慢慢漂移。我自己的原则是：**手写 `interface` 描述外部数据，基本都是 Schema 该出场的信号**。

## 在边界解码

```ts
const decodeCreateUser = Schema.decodeUnknownEffect(CreateUser)

const raw: unknown = { name: "Ada", email: "ada@example.com", age: 36, role: "admin" }

const decodeOnly = decodeCreateUser(raw).pipe(
  Effect.map((u) => sendWelcome(u.email))
)
```

输入是 `unknown`，输出是 `Effect<..., SchemaError>`。成功分支里的 `u` 是完整的 `CreateUser`，`u.email` 是 `Email` 品牌类型，可以直接交给 `sendWelcome`。不需要任何类型断言。

一个小习惯：`Schema.decodeUnknownEffect(CreateUser)` 返回的是函数，在模块顶层构造一次，之后到处复用。

## 失败是类型化的错误

解码失败不是抛异常，而是进入 Effect 的错误通道，类型是 `SchemaError`。所以你可以像处理其它领域错误一样 `catchTag`：

```ts
const decodeBad = decodeCreateUser(
  { name: "", email: "x", age: 1.5, role: "root" },
  { errors: "all" }
)

const asMessage = decodeBad.pipe(
  Effect.catchTag("SchemaError", (e) => Effect.succeed(e.message))
)
```

注意第二个参数 `{ errors: "all" }`。默认解码遇到第一个错误就停；表单类场景需要把所有错误一起返回给用户，就打开这个选项。这段代码的实际输出是：

```text
Expected a value with a length of at least 1
  at ["name"]
Expected a string matching the RegExp ^[^@\s]+@[^@\s]+\.[^@\s]+$
  at ["email"]
Expected an integer
  at ["age"]
Expected "admin" | "member"
  at ["role"]
```

四个字段的错误都在，带路径。`e.message` 适合日志；给 API 调用方的响应则应该是结构化的，不要把内部格式直接吐出去。

## 把 SchemaError 转成自己的领域错误

`SchemaError` 上有一个 `issue` 字段，用 `SchemaIssue` 的 formatter 可以把它平铺成 `{ path, message }` 列表。再用 `mapError` 转成面向 HTTP 的 `BadRequest`：

```ts
class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>
    readonly message: string
  }>
}> {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const parseBody = (body: unknown) =>
  decodeCreateUser(body, { errors: "all" }).pipe(
    Effect.mapError((e) => {
      const result = formatIssues(e.issue)
      return new BadRequest({
        issues: result.issues.map((i) => ({
          path: (i.path ?? []).map((p) => (typeof p === "object" ? p.key : p)),
          message: i.message,
        })),
      })
    })
  )
```

我把这一步放在边界的最外层：Schema 的细节（issue 树的形状）到这里为止，往里走的代码只认识 `BadRequest`。这和上一篇讲的"依赖放进 R"是同一个思路，只是这次放进类型里的是**失败**。

对非法输入 `{ name: "", email: "x", age: 1.5, role: "root" }`，`parseBody` 失败时 `issues` 里有四项，`path` 分别是 `["name"]`、`["email"]`、`["age"]`、`["role"]`。

## 解码与编码：Type 不等于 Encoded

Schema 是双向的。线上格式常常和内存里的类型不同，比如 id 是字符串、时间是 ISO 字符串：

```ts
const Wire = Schema.Struct({
  id: Schema.NumberFromString,
  createdAt: Schema.DateFromString,
})

type WireType = typeof Wire.Type
type WireEncoded = typeof Wire.Encoded
```

`WireType` 是 `{ id: number; createdAt: Date }`，`WireEncoded` 是 `{ id: string; createdAt: string }`。`decodeUnknownSync(Wire)({ id: "12", createdAt: "2026-10-21T00:00:00Z" })` 得到的是真正的 `number` 和 `Date`；反向 `encodeSync(Wire)` 又能还原成字符串。我实际运行过，往返一致。

解码、编码写在同一处，就没有"解析函数和序列化函数各写一遍然后不对称"的 bug。

## Class、错误、联合类型

需要带行为的领域对象时用 `Schema.Class`：

```ts
class Product extends Schema.Class<Product>("Product")({
  id: Schema.String,
  cents: Schema.Int,
}) {
  get usd() { return this.cents / 100 }
}
```

需要跨进程序列化的错误用 `Schema.TaggedError`：

```ts
class ProductNotFound extends Schema.TaggedError<ProductNotFound>()("ProductNotFound", {
  id: Schema.String,
}) {}
```

它既是可以 `yield*` 进错误通道的错误，又是一个 Schema，能在 RPC 或 HTTP 边界上编码解码。判别联合用 `Schema.TaggedStruct` 加 `Schema.Union`，收窄之后 `switch` 是穷尽检查的：

```ts
const Event = Schema.Union([
  Schema.TaggedStruct("Created", { id: Schema.String }),
  Schema.TaggedStruct("Deleted", { id: Schema.String, reason: Schema.String }),
])

const describe = (e: typeof Event.Type): string => {
  switch (e._tag) {
    case "Created": return `created ${e.id}`
    case "Deleted": return `deleted ${e.id}: ${e.reason}`
  }
}
```

直接吃 JSON 字符串的场景，用 `Schema.fromJsonString(CreateUser)` 把 `JSON.parse` 和校验合成一步，不再有"先 parse 再断言"的中间态。

## 和服务层拼在一起

边界解码、服务注入，两篇的内容在 handler 里汇合：

```ts
class UserStore extends Context.Service<UserStore, {
  readonly save: (u: CreateUser) => Effect.Effect<void>
}>()("app/UserStore") {}

const handler = (body: unknown) =>
  Effect.gen(function* () {
    const input = yield* parseBody(body)
    const store = yield* UserStore
    yield* store.save(input)
    return input.name
  })

const StoreTest = Layer.succeed(UserStore, { save: () => Effect.void })
```

`handler` 的类型是 `Effect<string, BadRequest, UserStore>`：入参 `unknown`，失败是 `BadRequest`，依赖是 `UserStore`，三件事一眼可见。测试时 `Effect.provide(StoreTest)` 即可。`save` 收到的 `input` 保证已通过校验，存储层不需要也不应该再校验一遍。

## 什么时候不该用

别把 Schema 撒得到处都是。边界内部的纯函数之间互相调用，用普通 TypeScript 类型就够了，重复解码只会浪费 CPU 和增加噪音。Schema 的位置是：HTTP body、数据库行、队列消息、环境变量、`localStorage`，也就是**信任边界**。

## 小结

- 在信任边界对 `unknown` 解码一次，通过的数据拥有真实类型，不再需要 `as`。
- v4 里用 `decodeUnknownEffect`、`SchemaError`、`.check(...)`、`Literals([...])`、`Union([...])`、`optionalKey`，v3 的写法会编译失败。
- 解码失败是类型化的 `SchemaError`，可 `catchTag`；传 `{ errors: "all" }` 累积全部字段错误，在边界转成自己的领域错误。
- `Type` 与 `Encoded` 来自同一份定义，解码、编码、静态类型、品牌类型不会漂移。
- 校验放在边界，核心逻辑只拿已解码的类型。

下一篇《Effect 并发与资源管理：Fiber、Scope 与中断保证清理》：解码之后的业务逻辑如何并发执行，并在中断时保证资源被清理。
