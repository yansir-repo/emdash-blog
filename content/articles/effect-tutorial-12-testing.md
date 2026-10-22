---
title: "测试：替身 Layer、可控的时间"
description: "Effect 教程第 12 章：依赖用 Layer 注入之后测试怎么变简单。讲替身 Layer、用 Effect.flip 断言类型化失败、TestClock 让超时与重试不再真等，以及共享 Layer 的取舍。"
date: 2026-10-11
category: effect
chapter: 12
tags: [effect, tutorial, testing]
---

前面几章铺垫的东西，在这一章集中兑现：依赖写进类型、实现由 Layer 提供、配置可替换。测试是这套设计最直接的受益者。

## 要解决的问题

写过后端测试的人大多熟悉这几类痛点：

- 被测代码调用了真实的支付网关或邮件服务，测试要么打到外部，要么得 mock 整个模块。
- 代码里有 `sleep(5000)` 或重试退避，测试要么真的等，要么把超时调得很小，结果测的已经不是线上的行为。
- 想断言「在第三次失败后放弃」这种行为，需要精心构造计数器与时序。
- 测试之间共享了状态，换个顺序跑就挂。

## 朴素做法为什么不够

模块级 mock（`vi.mock("./mailer")`）替换的粒度是文件，而且依赖于被测代码「恰好用某种方式 import」；它绕过类型系统，重构一改路径测试就悄悄失效。至于时间，`vi.useFakeTimers()` 能控制 `setTimeout`，但要求你对「被测代码内部用了哪些定时器」有所了解，并且和异步代码交织时容易产生微妙的时序问题。

两者共同的问题是：被测代码**没有声明**自己依赖外部系统和时间，所以测试只能从外面硬撬。

## Effect 的做法

### 替身是一个 Layer

既然外部能力都是服务，测试就是「提供另一个实现」。先看被测代码：

```ts
import { Context, Data, Effect } from "effect"

class PayError extends Data.TaggedError("PayError")<{ readonly reason: string }> {}

class Gateway extends Context.Service<Gateway, {
  readonly charge: (cents: number) => Effect.Effect<string, PayError>
}>()("app/Gateway") {}

const checkout = Effect.gen(function* () {
  const gw = yield* Gateway
  return yield* gw.charge(100).pipe(
    Effect.retry({ times: 2 }),
    Effect.timeout("5 seconds")
  )
})
```

`checkout` 的类型是 `Effect<string, PayError | TimeoutError, Gateway>`。替身就是给 `Gateway` 换一个实现：

```ts
import { assert, it } from "@effect/vitest"
import { Layer, Ref } from "effect"

it.effect("重试后成功", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const Fake = Layer.succeed(Gateway, {
      charge: () =>
        Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            n < 3 ? Effect.fail(new PayError({ reason: "flaky" })) : Effect.succeed("ok")
          )
        )
    })
    const out = yield* checkout.pipe(Effect.provide(Fake))
    assert.strictEqual(out, "ok")
    assert.strictEqual(yield* Ref.get(calls), 3)
  }))
```

替身前两次失败、第三次成功，`checkout` 的 `retry({ times: 2 })` 恰好重试到成功，断言调用次数是 3。替身是一个普通值，没有 mock 框架，类型照常检查：如果 `Gateway` 的接口改了，这个替身会编译失败，而不是悄悄过期。（`Ref` 是一个可变引用，第 18 章详谈；这里只当作「测试里的计数器」。）

`@effect/vitest` 的 `it.effect` 把测试体当作 Effect 来运行，并且自带一个 `Scope`：测试里用 `acquireRelease` 或 `addFinalizer` 登记的清理，会在测试结束时执行。

配置同理。上一章的 `Settings` 在测试里可以换成一个写死的 `Layer.succeed(Settings, {...})`，或者用 `ConfigProvider.fromEnvRecord` 提供一组假环境，业务代码不需要知道自己运行在测试里。换句话说，「测试」在 Effect 里不是一种特殊模式，只是**另一种装配**：同样的业务代码，在入口处接上真实的 Layer，在测试里接上替身的 Layer，两边共用的是同一份类型检查。这也是为什么前面几章反复强调接口小、方法不带 `R`：替身越好写，测试越愿意被写。

### 断言失败：flip

要断言「会以某个失败结束」，`Effect.flip` 把失败和成功互换：失败变成成功值，可以直接用普通断言检查。

```ts
it.effect("下游宕机时返回类型化失败", () =>
  Effect.gen(function* () {
    const Down = Layer.succeed(Gateway, {
      charge: () => Effect.fail(new PayError({ reason: "down" }))
    })
    const err = yield* checkout.pipe(Effect.provide(Down), Effect.flip)
    assert.strictEqual(err._tag, "PayError")
  }))
```

因为失败是类型的一部分（第 5 章），测试可以断言「失败的种类」，而不是匹配错误消息字符串。

### 可控的时间：TestClock

`it.effect` 提供的是一个**虚拟时钟** `TestClock`。在这个环境里，`Effect.sleep`、`Effect.timeout`、`Schedule` 都不会真的等待，它们等的是虚拟时间被推进。你来决定时间什么时候走。

标准模式是三步：fork 出去，推进时间，再取结果。

```ts
import { Fiber } from "effect"
import { TestClock } from "effect/testing"

it.effect("超时按虚拟时间触发", () =>
  Effect.gen(function* () {
    const Slow = Layer.succeed(Gateway, {
      charge: () => Effect.sleep("1 hour").pipe(Effect.as("late"))
    })
    const fiber = yield* checkout.pipe(
      Effect.provide(Slow),
      Effect.flip,
      Effect.forkChild
    )
    yield* TestClock.adjust("5 seconds")
    const err = yield* Fiber.join(fiber)
    assert.strictEqual((err as { _tag: string })._tag, "TimeoutError")
  }))
```

为什么要 fork：`checkout` 在睡眠时会阻塞当前 fiber，如果不先把它放到后台（`Effect.forkChild`，fiber 在第 13 章展开），就没有人去推进时钟了。流程是：后台启动它，把时钟拨快 5 秒，超时触发，再 `Fiber.join` 拿结果。整个测试几乎瞬间完成，而且测的正是线上用的 5 秒超时，不是被缩短的版本。

同样的做法适用于重试退避：把 `Schedule.spaced("1 minute")` 的重试 fork 出去，`TestClock.adjust("2 minutes")`，断言执行了 3 次。Schedule 与退避本身是第 16 章的内容。

注意 `TestClock` 要从 `effect/testing` 导入，不是 `effect` 根模块。

### 共享 Layer 与隔离

每个测试里 `Effect.provide` 自己的 Layer，是最隔离的做法，代价是重复构建。`@effect/vitest` 还提供 `layer(...)`，让整个 `describe` 块共享一次构建、结束时统一释放：

```ts
import { layer } from "@effect/vitest"

layer(SomeExpensiveLayer)("集成测试", (it) => {
  it.effect("用例", () => Effect.gen(function* () { /* ... */ }))
})
```

这适合构建成本高的资源（比如启动一个测试数据库）。要明白代价：块内所有用例看到的是**同一个实例**，服务内部的可变状态会在用例之间传递。需要隔离的状态，不要共享。

### 真实时间的例外

偶尔确实要用真实时钟（比如测试与一个真实子进程的交互），用 `it.live` 代替 `it.effect`。把它当作例外：能用虚拟时间验证的行为，就不要用真实时间。

## 常见误区

- **在 `it.effect` 里调用 `Effect.runPromise`**。测试体本身就是 Effect，直接 `yield*`；再嵌套运行会丢掉测试环境提供的 TestClock 与 Scope。
- **忘记 fork 就推进时钟**。症状是测试卡死：被测 Effect 在睡眠，没人去 `adjust`。
- **替身做得比真实实现更聪明**。替身应当尽量笨：返回预设值或预设失败。里面一旦有复杂逻辑，就需要给替身写测试了。
- **断言错误消息字符串**。优先断言 `_tag` 或类型，消息文案是最容易变的部分。
- **在共享 Layer 的块里依赖用例顺序**。共享状态会让用例互相耦合，换个顺序就挂。
- **用真实外部服务当「更真实的测试」**。集成测试有价值，但应当是少量、有意为之的一层；业务逻辑的主体测试应当跑在替身上，快而稳定。
- **版本不匹配**。`@effect/vitest` 对 `vitest` 的版本有 peer 要求（4.0.5 对应的 `@effect/vitest` 要求 vitest 5.x），装错版本会得到 peer 警告或运行期不兼容。

## 小结

- 依赖是服务，所以替身就是另一个 Layer：无 mock 框架，类型照常检查。
- 用 `Effect.flip` 断言类型化失败，断言种类而不是消息。
- `it.effect` 给你虚拟时钟：fork、`TestClock.adjust`、join，超时与重试不再真的等待。
- 共享 Layer 换来速度，代价是共享状态；隔离优先。

到这里，Part 3 的主线走完了：一段 Effect 的依赖、构建与测试，都收敛在类型与 Layer 里。下一部分进入并发：多个 Effect 同时运行时，谁来负责它们的生命周期？从 [Fiber 心智模型：结构化并发](/articles/effect-tutorial-13-fibers) 开始。

## 延伸阅读

- [Effect 运行时边界与测试：只在入口 run，用 TestClock 测时间](/articles/effect-runtime-boundaries-and-testing)
- [Effect 原生属性测试：Arbitrary、it.effect.prop 与 TestSchema](/articles/effect-property-testing)
- [Effect 重试与 Schedule：退避、抖动、repeat、超时与限流](/articles/effect-retry-and-schedule)
