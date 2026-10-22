---
title: "边界上的数据：Schema 基础，为什么不能相信 TypeScript 类型"
description: TypeScript 类型在运行时不存在，边界上的数据只是 unknown。本章讲清 Schema 如何把类型与运行时校验合为一份定义，以及解码、失败与「只在边界校验一次」的原则。
date: 2026-10-06
tags: [effect, tutorial, schema]
category: effect
series: effect-tutorial
seriesOrder: 7
---

前两章讲的是「操作失败」。这一章讲另一种更隐蔽的失败：**数据本身不是你以为的样子。** 这是 Part 2 的后半，也是进入 Schema 的第一步。

## 要解决的问题：类型只活在编译期

先看一段再普通不过的代码：

```ts
interface User { id: number; name: string }

const user = (await res.json()) as User
console.log(user.name.toUpperCase())
```

`as User` 是你对编译器的一句承诺，编译器照单全收。但 TypeScript 的类型会在编译后被完全擦除，运行时根本没有 `User` 这个东西。如果接口某天返回的是 `{ id: "7" }`，`name` 缺失，这行代码在 `toUpperCase` 处才炸，位置离真正的问题已经隔了好几层，而且报错信息是「cannot read properties of undefined」，完全看不出是哪里的数据出了问题。

问题出在**边界**：所有从程序外部进来的数据，HTTP 请求体、第三方 API 的响应、读到的文件、`localStorage`、环境变量，甚至 LLM 的输出，它们在编译器眼里的本来类型是 `unknown`。类型断言只是把「我不知道」改写成「我保证」，保证并不会因此成真。

## 朴素做法为什么不够

当然可以手写校验：

```ts
function parseUser(x: unknown): User {
  if (typeof x !== "object" || x === null) throw new Error("bad")
  if (typeof (x as any).id !== "number") throw new Error("bad id")
  // ...
}
```

这能工作，但有两个结构性缺点。其一，**校验逻辑和类型声明是两份东西**，改了其中一份忘了另一份，它们就会悄悄分叉，而且编译器发现不了。其二，每个字段、每个约束都要手写，错误信息也得自己拼，写到后来大家都想偷懒回到 `as`。

## Effect 的做法：一份定义，同时是类型和校验器

`Schema` 把这两件事合成一份。你用组合子描述数据的形状，它既是运行时的校验器，也能推导出静态类型：

```ts
import { Schema } from "effect"

const User = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.optionalKey(Schema.String)
})

type User = typeof User.Type
// { readonly id: number; readonly name: string; readonly email?: string }
```

`User` 是一个**值**，`User.Type` 是从它推出来的类型。形状只写一次，类型和校验永远一致。同一个来源生成的两样东西不会分叉，这是 Schema 最根本的价值。

## 解码：把 unknown 变成可信的类型

用 Schema 把外部数据变成内部类型的动作叫**解码**（decode）。最常用的是 `decodeUnknownEffect`，输入 `unknown`，输出一个 Effect：

```ts
import { Effect, Schema } from "effect"

const decodeUser = Schema.decodeUnknownEffect(User)

const program = Effect.gen(function* () {
  // 简写形式，失败类型是 UnknownError（第 4 章）；边界处更好的写法是自己翻译
  const raw: unknown = yield* Effect.tryPromise(() => res.json())
  const user = yield* decodeUser(raw)   // 成功后 user 的类型是 User
  return user.name.toUpperCase()
})
```

数据合法就得到一个真正符合类型的值；不合法则失败，失败类型是 `SchemaError`，带着指出「哪个字段、期望什么、实际是什么」的信息。注意这又回到了第 5 章：解码失败是一个**类型化的失败**，进入 `E`，可以用 `catchTag("SchemaError", ...)` 处理，也会在调用链里被编译器追踪。

不想要 Effect 的场合，还有同步版本 `Schema.decodeUnknownSync`（失败时抛异常），适合脚本、测试或确实可以崩溃的启动阶段。判断函数 `Schema.is(User)` 则只返回布尔，用于类型守卫。

需要知道一个默认行为：对 `Struct` 解码时，**多余的字段会被剔除**，输出里只留下 Schema 声明过的字段。想要严格拒绝多余字段，解码时传入 `{ onExcessProperty: "error" }`。这个默认行为对安全是友好的：不会让没声明的字段悄悄混进你的内部数据。

## 约束：形状之外的规则

类型能表达「这是个数字」，表达不了「这是个 1 到 150 之间的整数」。Schema 用 `check` 附加这类约束：

```ts
const Age = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 150 }))
const Name = Schema.String.check(Schema.isMinLength(1))
const Email = Schema.String.check(Schema.isPattern(/^[^@]+@[^@]+$/))
```

这些约束在解码时一并检查。数据一旦通过，你就知道它不只是「某个字符串」，而是「非空的字符串」。这条思路在下一章会进一步延伸。

## 核心原则：在边界解码一次，内部信任类型

有了解码，边界该怎么设计？一条简单清晰的原则：

1. **外部数据进入程序的第一刻就解码**，在入口处把 `unknown` 换成强类型。
2. **解码之后，内部所有函数都直接使用强类型**，不再重复校验。
3. 边界之外没有 `as` 断言，也没有 `any`。

这就像机场安检：检查集中在入口做一次，进了候机厅之后你不会在每个登机口再安检一遍。反之，如果校验散落各处，要么重复浪费，要么总有一处被漏掉。

解码失败后怎么办，是第 6 章的设计问题：通常在边界处用 `mapError` 把 `SchemaError` 翻译成领域错误，比如 `InvalidRequest`，并保留 `cause`。别让 `SchemaError` 一路泄漏到业务层的类型里。

## 编码：反方向也存在

Schema 描述的是**双向**转换。除了解码，还有 `Schema.encodeEffect`，把内部类型转回外部表示。对于简单的 `Struct`，编码和解码几乎一样，没有什么感觉；等到下一章讲转换（比如内部用 `Date`，外部用字符串）时，你会发现 `Type`（内部形态）和 `Encoded`（外部形态）并不相同，这时双向就有意义了。现在先记住：**Schema 不只是「校验」，而是「外部表示和内部类型之间的一座桥」。**

## 常见误区

- **用 `as` 断言替代解码。** 编译器通过了，运行时的安全一分没增加。凡是 `as` 出现在边界上，几乎都该换成解码。
- **以为 TypeScript 类型会保护你。** 类型保护的是你写的代码之间的一致性，保护不了进入代码之前的数据。
- **到处重复校验。** 解码是边界动作，内部再校验一次既浪费，也暗示边界没设计清楚。
- **把 `SchemaError` 当领域错误向上暴露。** 它是校验库的内部语言，上层关心的是「请求不合法」，而不是校验库的格式。
- **以为解码后会原样保留所有字段。** 默认会剔除未声明字段，需要保留时必须在 Schema 里声明。
- **只校验形状，不校验约束。** 字段是字符串不等于字段可用，该有的长度、范围、格式都应该写进 Schema。

## 小结

TypeScript 类型在运行时不存在，所以边界上的数据永远要先当作 `unknown`。Schema 用一份定义同时给出类型与校验，`decodeUnknownEffect` 把解码变成一个类型化失败的 Effect。原则是：边界解码一次，内部信任类型。

形状与约束只是起点。下一章用 Schema 做真正的**建模**：转换、品牌类型、判别联合，见 [第 8 章](/articles/effect-tutorial-08-schema-modeling)。

## 延伸阅读

- [Effect Schema：在边界处解码数据](/articles/effect-schema-at-the-boundary)
- [Effect Schema 工具链](/articles/effect-schema-toolchain)
- [Effect Schema 的判别联合](/articles/effect-schema-tagged-union)
