---
title: "Effect 原生属性测试：Arbitrary、it.effect.prop 与 TestSchema"
description: "Effect v4 内置基于 Schema 的属性测试：Arbitrary 派生生成器，checkEffect 提供可复现 seed 与结构化 shrinking，配合 it.prop 与 TestSchema，无需 fast-check。"
date: 2026-10-22
category: effect
tags: [effect, advanced, testing]
---

example-based 测试写的是「我想到的几个输入」，属性测试写的是「对所有合法输入都成立的规律」，由框架生成几百个输入去找反例，找到之后再缩小成最小的失败案例。这种方式特别适合有明确代数性质的代码：编码再解码应当还原、合并操作应当满足交换律、状态转换不应当产生非法状态。

在 Effect v3 里做属性测试要引入 fast-check，再用 `Arbitrary.make(schema)` 桥接。v4 把这件事做成了原生能力：`effect/Arbitrary` 模块自己实现了生成、shrinking 与重放，不依赖 fast-check。这篇讲怎么用，以及我在 4.0.5 上踩到的两个行为。

先说稳定性：`Arbitrary` 模块、`TestSchema`、`@effect/vitest` 的 `prop` 在 JSDoc 里全部标注为 `@stability unstable`。其中重放 token 的文档明确写了跨版本不保证兼容。可以用，但别把 replay 字符串当成长期存档格式。验证环境：effect 4.0.5、@effect/vitest 4.0.5、vitest 5.0.5（`@effect/vitest` 要求 vitest 在 5.x）。

## Arbitrary.schema：从 Schema 派生生成器

`Arbitrary.schema(schema)` 从 Schema 的 `Type` 一侧派生出一个 `Arbitrary`，它只是一个纯描述，不会自己跑，要交给 `sampleEffect` 或 `checkEffect`。Schema 里的检查会被遵守，比如下面 `x` 一定在 0 到 100 之间：

```ts
import { Arbitrary, Effect, Schema } from "effect"

const Point = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  y: Schema.Int
})
const arb = Arbitrary.schema(Point)

const program = Effect.gen(function* () {
  // 取样：同一个 seed 得到同一批值
  const a = yield* Arbitrary.sampleEffect(arb, { count: 3, seed: 42 })
  const b = yield* Arbitrary.sampleEffect(arb, { count: 3, seed: 42 })
  console.log(a) // [ { x: 98, y: 1 }, { x: 76, y: -84 }, { x: 83, y: 6 } ]
  console.log(JSON.stringify(a) === JSON.stringify(b)) // true

  // 检查属性：故意写一个错的
  const result = yield* Arbitrary.checkEffect(arb, (p) => p.x + p.y < 50, { runs: 100, seed: 1 })
  if (result._tag === "Falsified") {
    console.log(result.initialInput) // { x: 100, y: -1 }
    console.log(result.shrunkInput) // { x: 51, y: 0 }
    console.log(result.replay) // [0,"1",1,0,[2,0,0,0,0,0,1],"ReturnedFalse"]
    console.log(Arbitrary.formatCheckFailure(result))

    // 用 replay 复现同一个失败，不需要知道 seed
    const again = yield* Arbitrary.checkEffect(arb, (p) => p.x + p.y < 50, { replay: result.replay })
    console.log(again._tag) // Falsified
  }
})

Effect.runPromise(program)
```

`checkEffect` 的返回值是普通数据而不是抛异常，`CheckResult` 有四种：`Passed`、`Falsified`、`Exhausted`（过滤太苛刻，生成的候选被丢弃太多）、`ReplayMismatch`（重放的 token 对不上了）。它自己不会让测试失败，需要你判断 `_tag`，或者用 `formatCheckFailure` 把非 `Passed` 的结果格式化成诊断文本。

### 可复现：seed 与 replay

两种复现手段：

- `seed`：固定随机种子，同一个 seed 在同一实现下得到同一批输入。没传 seed 时，种子由 Effect 的 `Random` 服务选取；失败结果里的 `replay`（或 `Exhausted` 里的 `seed`）会记下实际用到的值。
- `replay`：`Falsified` 结果自带的字符串，记录了种子、第几次尝试、大小以及完整的 shrink 路径。传给 `checkEffect` 的 `replay` 选项后，其它的 `runs`、`seed`、`size` 选项都会被忽略，直接重放那一次失败。

CI 里失败了，把日志里的 replay 贴到本地就能复现，这是比「再跑一遍看看」可靠得多的流程。

### 结构化 shrinking

shrinking 是属性测试真正值钱的部分：随机找到的失败输入往往又长又乱，需要缩成人能读的最小反例。这里的 shrink 是**结构化**的：Schema 的每一层（对象字段、数组元素、联合分支）都知道怎么变小，而且每个候选都要重新通过 Schema 的检查才会交给你的属性，所以缩小过程不会产出违反约束的值。上面那次失败从 `{ x: 100, y: -1 }` 缩到了 `{ x: 51, y: 0 }`，7 步。注意它不保证全局最小（这里 `{ x: 50, y: 0 }` 才是），`maxShrinks` 限定了预算，用完就返回当前找到的最好结果。

需要自己定义怎么缩时，`Arbitrary.schema(schema, { shrink })` 的回调返回「一步可达的更简单候选」，它会**整体替换**由 Schema 推导的 shrink，且必须同步、确定、会终止。我试过 `shrink: (n) => n > 0 ? [n - 1] : []`，对属性 `n < 5` 从 6 缩到 5，正好是最小反例。

### 组合：map、filter、all

生成器可以组合，用来构造相关的输入，比如「`a < b` 的一对整数」：

```ts
import { Arbitrary, Effect, Schema } from "effect"

const Id = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 }))
const pair = Arbitrary.all({ a: Arbitrary.schema(Id), b: Arbitrary.schema(Id) }).pipe(
  Arbitrary.filter(({ a, b }) => a < b)
)
const doubled = Arbitrary.schema(Id).pipe(Arbitrary.map((n) => n * 2))

Effect.runPromise(
  Effect.gen(function* () {
    console.log(yield* Arbitrary.sampleEffect(pair, { count: 3, seed: 1 }))
    // [ { a: 2, b: 9 }, { a: 1, b: 2 }, { a: 3, b: 5 } ]
    console.log(yield* Arbitrary.sampleEffect(doubled, { count: 3, seed: 1 })) // [ 6, 18, 16 ]
  })
)
```

`filter` 过度会导致 `Exhausted`，能用构造方式表达的约束（`map`、`flatMap`）优先于事后过滤。

## @effect/vitest：it.prop 与 it.effect.prop

手写 `checkEffect` 再判断 `_tag` 很啰嗦，`@effect/vitest` 把它包成了测试注册 API。`it.prop` 用于同步属性，`it.effect.prop` 用于返回 Effect 的属性，参数可以是 Schema、`Arbitrary`，写成对象或元组都行，回调里按同样的结构拿到值。

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

const Money = Schema.Struct({
  amount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  currency: Schema.Literals(["CNY", "USD"])
})
type Money = typeof Money.Type

const add = (a: Money, b: Money): Money => ({ amount: a.amount + b.amount, currency: a.currency })

describe("Money", () => {
  // 同步属性：抛异常或返回 false 都算失败
  it.prop("add 满足交换律", { a: Money, b: Money }, ({ a, b }) => {
    const b2 = { ...b, currency: a.currency }
    expect(add(a, b2)).toEqual(add(b2, a))
  })

  // Effect 属性：typed failure、抛异常、defect 都算失败；选项里可固定 seed 和 runs
  it.effect.prop(
    "编码再解码得到原值",
    { m: Money },
    ({ m }) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(Money)(m)
        const decoded = yield* Schema.decodeUnknownEffect(Money)(encoded)
        expect(decoded).toEqual(m)
      }),
    { arbitrary: { runs: 50, seed: 7 } }
  )
})
```

失败时输出会带上 shrink 之后的输入和 replay。我故意写了一个有 bug 的属性（对 `{ lo, hi }` 断言 `hi - lo >= 0`），vitest 的报告是这样的：

```text
Error: Property falsified after 3 run(s) and 0 shrink(s)
Shrunk input: {"r":{
  "lo": 1,
  "hi": 0
}}
Failure: AssertionError: expected -1 to be greater than or equal to 0
Replay: [0,"1",2,0,[],"PropertyError"]
```

两个行为要知道：

- 回调里用 `expect` 抛出的断言错误也会被当成「属性被证伪」并触发 shrink，所以不需要把断言改写成返回布尔值。
- vitest 的超时会中断运行生成、属性和 shrink 的 fiber，Effect 的 finalizer 会执行；但同步的死循环无法被抢占。

## TestSchema.Asserts：Schema 自己的断言

`effect/testing` 里的 `TestSchema.Asserts` 是专门测 Schema 的断言集合，用 `new TestSchema.Asserts(schema)` 创建：

- `decoding().succeed(input, expected?)` 和 `decoding().fail(input, message)`：断言解码结果或格式化后的错误信息。
- `encoding().succeed(value, expected?)`：断言编码结果。
- `verifyRoundTrip(options?)`：对生成的值做「编码再解码」，断言与原值深度相等，失败时带 shrink 后的输入和 replay。
- `arbitrary().verifyGeneration(options?)`：检查生成器产出的值都满足 Schema。
- `decoding` 和 `encoding` 另有 `succeedEffect`、`failEffect`，往返有 `verifyRoundTripEffect`，返回惰性的 Effect，用于需要服务的 Schema。

```ts
import { describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { TestSchema } from "effect/testing"

class Payment extends Schema.Class<Payment>("Payment")({
  id: Schema.Int,
  amount: Schema.NumberFromString
}) {}

describe("Payment schema", () => {
  const asserts = new TestSchema.Asserts(Payment)

  it("编码", async () => {
    await new TestSchema.Asserts(Schema.NumberFromString).encoding().succeed(42, "42")
  })

  it("解码失败的信息", async () => {
    await asserts
      .decoding({ parseOptions: { errors: "all" } })
      .fail({ id: 1.5, amount: 5 }, [
        "Expected an integer",
        "  at [\"id\"]",
        "Expected string",
        "  at [\"amount\"]"
      ].join("\n"))
  })

  it("往返", async () => {
    await asserts.verifyRoundTrip({ runs: 50, seed: 3 })
    asserts.arbitrary().verifyGeneration({ seed: 1 })
  })
})
```

这一段里「解码失败的信息」断言的是完整的格式化文本，`errors: "all"` 让所有字段的错误都出现，而不是第一个就停。

### 一个坑：Struct 上的 verifyRoundTrip（4.0.5）

我在 4.0.5 上遇到的实际行为：对 `Schema.Struct` 调 `verifyRoundTrip` 会失败，即使 Schema 完全正常。例如 `new TestSchema.Asserts(Schema.Struct({ a: Schema.String })).verifyRoundTrip({ seed: 1 })` 报 `Shrunk input: {"a":""}`、`Failure: returned false`。

原因是我实际排查出来的两点。Struct 的 Arbitrary 产出的对象原型是 `null`（`Object.getPrototypeOf` 得到 `null`），而解码结果是普通对象；`verifyRoundTrip` 用 Node 的 `isDeepStrictEqual` 比较，它会比较原型，所以即使字段完全相同也判为不等。另外 `Schema.Number` 的生成器会产出 `-0`，`NumberFromString` 往返后变成 `0`，同样被严格相等拒绝。`Schema.Class` 的实例不受影响，上面的 `Payment` 就能通过，纯 `string` 这类原始 Schema 也能通过。

这是 4.0.5 的现状，我没有去查它是不是已被确认为缺陷，所以不替它下结论。可行的绕法是自己用 `checkEffect` 加 `Schema.toEquivalence`，比较规则由 Schema 决定，不依赖原型：

```ts
import { Arbitrary, Effect, Schema } from "effect"

const Wire = Schema.Struct({
  id: Schema.Int,
  at: Schema.DateTimeUtcFromString,
  n: Schema.NumberFromString
})

const roundTrip = Effect.gen(function* () {
  const eq = Schema.toEquivalence(Wire)
  const result = yield* Arbitrary.checkEffect(
    Arbitrary.schema(Wire),
    (w) =>
      Schema.encodeEffect(Wire)(w).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Wire)),
        Effect.map((back) => eq(back, w))
      ),
    { runs: 200, seed: 1 }
  )
  console.log(result._tag) // Passed
})

Effect.runPromise(roundTrip)
```

## 选型

- 有明确代数性质（往返、幂等、交换、不变量）的纯逻辑：`it.prop`，这是投入产出比最高的地方。
- 需要 Effect 环境、服务或异步的属性：`it.effect.prop`，配合[运行时边界与测试那篇](/articles/effect-runtime-boundaries-and-testing)里的 `TestClock` 与 Layer。
- Schema 本身的编解码行为：`TestSchema.Asserts`，具体输入输出用 `decoding`、`encoding`，往返用 `verifyRoundTrip`（Struct 上先确认上面的坑）。
- 需要在非 vitest 环境，或要对结果做自定义处理：直接用 `checkEffect`。

属性测试不替代 example 测试。我的做法是 example 测试固定已知的边界和回归，属性测试覆盖「我没想到的输入」，两者互补，不互相替代。

## 小结

v4 的属性测试不再依赖 fast-check：`Arbitrary.schema` 从 Schema 派生生成器并遵守所有检查，`checkEffect` 把结果作为数据返回，带可复现的 seed、可重放的 replay 以及结构化 shrinking；`@effect/vitest` 的 `it.prop` 与 `it.effect.prop` 把它接进测试注册；`TestSchema.Asserts` 覆盖编码、解码和往返断言。

要记住三件事：这几个模块都是 `unstable`，replay 不跨版本；shrinking 受 `maxShrinks` 限制，不保证全局最小；4.0.5 上 Struct 的 `verifyRoundTrip` 会因原型比较失败，用 `checkEffect` 加 `toEquivalence` 代替。
