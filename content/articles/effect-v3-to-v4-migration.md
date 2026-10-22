---
title: Effect v3 到 v4 迁移实录：改名清单与会咬人的行为差异
description: 在 effect 4.0.5 上逐条验证的 v3 到 v4 迁移清单：catchAll、Either、Effect.Service、fork 等改名，以及 runPromise 拒绝值等行为差异。
date: 2026-10-20
category: effect
tags: [effect, guide]
---

这篇不是迁移指南的转述，而是一份核对记录。我在同一台机器上装了 `effect@3.22.3` 和 `effect@4.0.5`，每一条结论都在 4.0.5 上验证过，凡是涉及「v3 里是什么样」的地方，再用 3.22.3 对照确认一遍。凡是文中说「不存在」的 API，都是用 `tsc` 的 `@ts-expect-error` 或运行时检查证实过的，不是凭记忆。

代码在 strict 与 `exactOptionalPropertyTypes` 下编译，行为部分用 `@effect/vitest` 实际跑过。

为什么要这样？因为迁移资料最容易过期，而且过期得悄无声息。后面有一节专门讲这件事。

## 先让工具替你找

不要从读清单开始，先让编译器报错。被移除的 API 在 4.0.5 里直接是 `TS2339`（属性不存在），所以升级之后 `tsc` 会给你一份最完整的待办。

更好的是 Effect 的 language service。`@effect/tsgo` 有一条 `outdatedApi` 诊断，专门检测「v3 才有的 API」，并且给出替代写法。我把它设成 `error`：

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnosticSeverity": { "outdatedApi": "error", "floatingEffect": "error" }
      }
    ]
  }
}
```

在 `typescript@7.0.2` 与 `@effect/tsgo@0.45.0` 上，我把一批 v3 写法扔给它，得到的提示是这样的（摘录）：

- `Effect.fork`：Renamed to forkChild。
- `Effect.either`：Renamed to result，并提醒返回的是 `Result.Result<A, E>` 而不是 `Either<E, A>`。
- `Effect.Service`：Use Context.Service instead。
- `Effect.async`：Renamed to callback。
- `Effect.zipRight`：Use Effect.andThen instead。
- `Effect.catchAll`：Renamed to catch。

覆盖并不完整：`Layer.scoped`、`Context.Tag`、`Schema.decodeUnknown` 这几个只会得到 `tsc` 自己的「不存在」错误，没有改名提示。所以工具是起点，不是终点，下面的清单仍然需要。

## 服务：Effect.Service、Context.Tag 与 Layer.scoped 一起消失

三件事其实是同一个变化：服务只有一种声明方式 `Context.Service`，Layer 构造只有一个 `Layer.effect`。

- `Effect.Service` 不存在了，`Context.Tag` 和 `Context.GenericTag` 也不存在。统一用 `Context.Service`。
- `Layer.scoped` 不存在了。`Layer.effect` 的类型会把 `Scope` 从需求里扣掉，构建 Layer 时用 `acquireRelease` 注册的资源，会在 Layer 的作用域关闭时释放。
- v3 的 `Effect.Tag` 式静态访问器没有了，取而代之的是 `Service.use(f)`。
- `Layer.succeed` 有两种写法都能用：`Layer.succeed(Tag, impl)` 和 `Layer.succeed(Tag)(impl)`。

```ts
// mailer.ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

export const events: Array<string> = []

export class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string) => Effect.Effect<void>
}>()("app/Mailer") {
  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push("connect")),
        () => Effect.sync(() => events.push("disconnect"))
      )
      return Mailer.of({ send: (to) => Effect.sync(() => events.push(`send ${to}`)) })
    })
  )
}

export const notify = Mailer.use((mailer) => mailer.send("a@example.com"))

export const runOnce = async () => {
  const runtime = ManagedRuntime.make(Mailer.layer)
  await runtime.runPromise(notify)
  await runtime.dispose()
}
```

跑完之后 `events` 是 `connect`、`send a@example.com`、`disconnect`：资源在 `dispose` 时按顺序释放，没有 `Layer.scoped` 也没有手动的 `Effect.scoped`。

`Context.Service` 还接受一个 `make` 选项，把构造逻辑放在服务类上，之后用 `Layer.effect(Self, Self.make)` 组装：

```ts
// counter.ts
import { Context, Effect, Layer, Ref } from "effect"

export class Counter extends Context.Service<Counter, {
  readonly next: Effect.Effect<number>
}>()("app/Counter", {
  make: Effect.gen(function* () {
    const ref = yield* Ref.make(0)
    return { next: Ref.updateAndGet(ref, (n) => n + 1) }
  })
}) {
  static readonly layer = Layer.effect(Counter, Counter.make)
}
```

注意 v3 的 `Effect.Service` 里的 `dependencies` 与 `accessors` 选项也一并没有了：依赖用 `Layer.provide` 接，访问用 `use`。更完整的服务与 Layer 写法在 [services 与 layers 那篇](/articles/effect-services-and-layers)。

运行时那一侧，`Runtime.runPromise` 之类的函数在 4.0.5 里不存在，长驻宿主用 `ManagedRuntime.make`，见上面的 `runOnce`，细节在 [运行时边界那篇](/articles/effect-runtime-boundaries-and-testing)。

## 错误与结果：catch、result 与 Result

- `Effect.catchAll` 改名 `Effect.catch`，`catchAllCause` 改名 `catchCause`，`catchAllDefect` 改名 `catchDefect`，`tapErrorCause` 改名 `tapCause`。
- `Effect.either` 改名 `Effect.result`，`Either` 模块整个被 `Result` 取代：构造器是 `Result.succeed` 与 `Result.fail`，没有 `left`、`right`、`isLeft`。类型参数顺序是 `Result<A, E>`，成功在前，和 `Effect<A, E>` 保持一致。
- `Effect.catchSome` 不存在了，language service 的提示是改用 `Effect.catchIf`：不再传一个返回 `Option<Effect>` 的函数，而是分开传 predicate 与 handler。`Effect.orElse` 也不存在了，改用 `Effect.catch` 或 `Effect.matchEffect`。
- `Option.fromNullable` 变成 `Option.fromNullishOr`。

```ts
// errors.ts
import { Data, Effect, Result } from "effect"

class A extends Data.TaggedError("A")<{}> {}
class B extends Data.TaggedError("B")<{}> {}

const program: Effect.Effect<number, "boom"> = Effect.fail("boom")

export const recovered = program.pipe(Effect.catch((e) => Effect.succeed(e.length)))

export const described = Effect.gen(function* () {
  const result = yield* Effect.result(program)
  return Result.match(result, {
    onSuccess: (n) => `ok ${n}`,
    onFailure: (e) => `err ${e}`
  })
})

const mixed: Effect.Effect<number, A | B> = Effect.fail(new B())

// catchTag 多了第三个参数：兜底处理没被点名的其余错误
export const withRest = mixed.pipe(
  Effect.catchTag("A", () => Effect.succeed(0), (rest) => Effect.succeed(rest._tag === "B" ? -1 : -2))
)
```

`catchTag` 的第三个参数是 v4 新增的，我验证过它拿到的是「去掉已处理 tag 之后」的错误类型。结合 `Effect.catchReason`（处理错误对象里嵌套的 `reason`），写错误映射比 v3 顺手得多，用法见 [Effect AI 那篇](/articles/effect-ai)。

## 并发：fork 改名与语义没变

- `Effect.fork` 改名 `Effect.forkChild`，`Effect.forkDaemon` 改名 `Effect.forkDetach`。`forkScoped`、`forkIn` 不变。
- `Effect.async` 改名 `Effect.callback`。
- `Effect.makeSemaphore` 与 `Effect.makeLatch` 不存在了，用根导出的 `Semaphore.make` 与 `Latch.make`。

改名不改语义，我专门验证了：`forkChild` 出来的 fiber 随父 fiber 结束被中断，`forkDetach` 的不会。

```ts
// fork.test.ts
import { it, expect } from "@effect/vitest"
import { Effect, Fiber, Ref } from "effect"

const watch = (state: Ref.Ref<string>) =>
  Effect.never.pipe(Effect.onInterrupt(() => Ref.set(state, "interrupted")))

it.effect("forkChild 随父结束被中断，forkDetach 不会", () =>
  Effect.gen(function* () {
    const child = yield* Ref.make("running")
    const detached = yield* Ref.make("running")
    const parent = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Effect.forkChild(watch(child))
        yield* Effect.forkDetach(watch(detached))
        yield* Effect.yieldNow
      })
    )
    yield* Fiber.join(parent)
    yield* Effect.yieldNow
    yield* Effect.yieldNow
    expect(yield* Ref.get(child)).toBe("interrupted")
    expect(yield* Ref.get(detached)).toBe("running")
  })
)
```

并发与资源的完整讲解在 [并发与资源那篇](/articles/effect-concurrency-and-resources)。

## Schema 与 Config：表面变得更小

Schema 的变化最多，下面只列最常撞上的：

- `Schema.decodeUnknown` 改名 `decodeUnknownEffect`，`encodeUnknown` 改名 `encodeUnknownEffect`。`decodeUnknownSync` 保留。
- 注意陷阱：`Schema.decode` 与 `Schema.encode` 这两个名字在 v4 里仍然存在，但含义变了，它们现在是「给 schema 加转换」的组合子，不再是执行解码的函数。执行解码要用 `decodeEffect`、`encodeEffect`。
- `Schema.Union(A, B)` 必须传数组 `Schema.Union([A, B])`；多个字面量用 `Schema.Literals([...])`；`Schema.Record` 接两个参数 `Schema.Record(Key, Value)`。
- `Schema.filter` 与 `minLength` 这一类被统一成 `.check(Schema.isMinLength(1))`；`Schema.annotations` 变成 `.annotate`；`parseJson` 变成 `fromJsonString`；`transform` 变成 `decodeTo`；`withDefaults` 不存在了，解码默认值用 `withDecodingDefault`，构造默认值用 `withConstructorDefault`。
- `Schema.optionalWith` 没有了。`optional` 允许值是 `undefined`，`optionalKey` 只允许省略这个键，传 `undefined` 会解码失败，这点在 `exactOptionalPropertyTypes` 下尤其重要。
- 错误类：`Schema.TaggedError<Self>()("Tag", fields)` 的形状在 4.0.5 里没有变，仍然可以直接 `yield*`、用 `catchTag` 处理。

```ts
// schema.ts
import { Schema } from "effect"

export const Id = Schema.String.check(Schema.isMinLength(1))
export const Status = Schema.Literals(["draft", "published"])
export const Scores = Schema.Record(Schema.String, Schema.Number)
export const IdOrNumber = Schema.Union([Id, Schema.Number])

export const Payload = Schema.fromJsonString(
  Schema.Struct({
    id: Id,
    status: Status,
    note: Schema.optional(Schema.String),
    nickname: Schema.optionalKey(Schema.String)
  })
)

export const decodePayload = Schema.decodeUnknownEffect(Payload)

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}
```

Config 同理，名字都变成了大写开头的函数：`Config.string` 是 `Config.String`，`Config.redacted` 是 `Config.Redacted`，`number`、`integer`、`boolean` 对应 `Number`、`Int`、`Boolean`。`Duration.decode` 变成 `Duration.fromInputUnsafe`，也算同一类。Schema 的完整用法在 [边界解码那篇](/articles/effect-schema-at-the-boundary)。

## 模块搬家：不再有 @effect/platform 与 unstable

这是迁移里体感最强的变化。v3 时代分散在 `@effect/platform`、`@effect/rpc`、`@effect/sql`、`@effect/ai` 等包里的东西，在 4.0.5 里已经并进了 `effect` 本身，并且是稳定路径：

```ts
// layout.ts
import { FileSystem, Latch, Semaphore } from "effect"
import { LanguageModel } from "effect/ai"
import { HttpClient } from "effect/http"
import { Rpc } from "effect/rpc"
import { SqlClient } from "effect/sql"

export { FileSystem, HttpClient, LanguageModel, Latch, Rpc, Semaphore, SqlClient }
```

这些导入我都编译过。反过来，`effect/unstable/ai` 这类路径在 4.0.5 里解析不出来，`@effect/platform` 在 npm 上最新的是 0.97 这条 v3 线。需要独立安装的是运行时适配与具体 provider：`@effect/platform-node`、`@effect/ai-openai`、`@effect/sql-pg`、`@effect/opentelemetry`、`@effect/vitest`，它们的 `latest` 标签都是 4.0.5，和核心包对齐。

## 会咬人的行为差异

改名编译器会替你找，下面这些是编译器不会拦、运行时才露出来的。每一条我都在 3.22.3 与 4.0.5 上各跑了一次，对照确认。

- **`runPromise` 的拒绝值**。v3 里失败会被包成 `FiberFailure`，`catch (e)` 里 `e instanceof MyError` 是 `false`。v4 直接拒绝原始的错误对象，`instanceof` 成立；`Effect.die("x")` 则直接拒绝字符串 `"x"`。依赖旧行为的错误处理中间件要重新检查。
- **Option 与 Result 不再是 Effect**。v3 里可以在 `Effect.gen` 里 `yield* Option.some(1)`，`yield* Either.left(...)` 会让 Effect 失败；v4 里这既是类型错误，运行时也会报 `Not a valid effect`。显式转换：`Effect.fromOption`（缺值时以 `NoSuchElementError` 失败）与 `Effect.fromResult`。
- **超时错误改名**。`Effect.timeout` 的失败从 `TimeoutException` 变成 `Cause.TimeoutError`，`_tag` 同步改为 `"TimeoutError"`，类型化的 `catchTag("TimeoutException")` 会直接编译失败，但手写 `_tag === "TimeoutException"` 比较的地方会静默失效，需要全局搜一遍。
- **`Stream.runCollect` 返回数组**。v3 返回 `Chunk`，v4 返回普通 `Array`。所有对结果调用 `Chunk.toReadonlyArray` 的地方都要改。
- **解码错误改名**。`ParseError` 变成 `SchemaError`，同步解码抛出的也是 `SchemaError`。
- **Cause 的形状**。v3 的 `Cause` 是一棵树（`Sequential`、`Parallel`），v4 是扁平的，通过 `cause.reasons` 拿到一个数组，元素 `_tag` 是 `Fail`、`Die`、`Interrupt`。
- **缺失配置的报错**。`Config.Redacted("KEY")` 缺失时，失败是 `ConfigError`，里面包着 `SchemaError`，信息是 `Expected string at ["KEY"]`，变量名只出现在路径里，对运维不算友好，值得自己再包一层。

```ts
// behaviors.test.ts
import { it, expect } from "@effect/vitest"
import { Cause, Data, Effect, Fiber, Option, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"

class MyError extends Data.TaggedError("MyError")<{ readonly n: number }> {}

it("runPromise 拒绝原始错误对象", async () => {
  const rejected = await Effect.runPromise(Effect.fail(new MyError({ n: 1 }))).catch((e: unknown) => e)
  expect(rejected instanceof MyError).toBe(true)
})

it.effect("Option 与 Result 需要显式转换", () =>
  Effect.gen(function* () {
    const none = yield* Effect.flip(Effect.fromOption(Option.none<number>()))
    expect(none._tag).toBe("NoSuchElementError")
    const failed = yield* Effect.flip(Effect.fromResult(Result.fail("bad")))
    expect(failed).toBe("bad")
  })
)

it.effect("timeout 失败是 TimeoutError", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flip(Effect.timeout(Effect.never, "10 millis")))
    yield* TestClock.adjust("10 millis")
    const error = yield* Fiber.join(fiber)
    expect(error._tag).toBe("TimeoutError")
  })
)

it.effect("runCollect、SchemaError、Cause.reasons", () =>
  Effect.gen(function* () {
    const collected = yield* Stream.runCollect(Stream.make(1, 2, 3))
    expect(Array.isArray(collected)).toBe(true)

    const decodeError = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.Number)("x"))
    expect(decodeError._tag).toBe("SchemaError")

    const cause = Cause.combine(Cause.fail("a"), Cause.die("b"))
    expect(cause.reasons.map((r) => r._tag)).toEqual(["Fail", "Die"])
  })
)
```

## 推荐的迁移顺序

我会按下面的顺序做，每一步都能单独验证，出了问题也能定位到是哪一类变化：

1. 先把 `effect` 固定到一个确定的 4.0.x 版本，并同步升级 `@effect/vitest`、`@effect/platform-node` 等配套包，让它们和核心包版本一致。
2. 打开 language service，把 `outdatedApi` 与 `floatingEffect` 设为 `error`，让诊断列出全部待办。
3. 先处理模块搬家：把 `@effect/platform`、`@effect/rpc`、`@effect/sql`、`@effect/ai` 的导入改成 `effect/http`、`effect/rpc`、`effect/sql`、`effect/ai`。这一步改动最机械，先做完，后面的报错会干净很多。
4. 再处理改名，然后是服务与 Layer 的声明方式。
5. 最后读「行为差异」那一节，针对 `runPromise` 错误处理、`runCollect`、超时与解码错误的地方补测试。

## 小结

迁移可以拆成三个层次，难度递增：

- 改名：`catchAll` 到 `catch`，`Either` 到 `Result`，`fork` 到 `forkChild`，`async` 到 `callback`，`decodeUnknown` 到 `decodeUnknownEffect`。编译器与 `outdatedApi` 会找到它们。
- 形态收敛：服务只有 `Context.Service`，Layer 只有 `Layer.effect`，Schema 的组合子换成 `check`、`annotate`、`decodeTo`，包布局并入 `effect`，不再有 `unstable` 子路径。
- 行为差异：`runPromise` 的拒绝值、Option 不能 `yield*`、`TimeoutError`、`runCollect` 返回数组、`SchemaError`、`Cause.reasons`。这一层编译器不会拦，需要靠测试。

我的建议是：先让 `tsc` 与 language service 把第一层清完，再逐条对照第三层写测试，最后把迁移时发现的每一类问题变成一条规则，别让同样的坑出现第二次。
