---
title: "用 Schema 建模：transform、brand 与判别联合"
description: 从校验走向建模：用 transform 连接外部表示与内部类型，用 brand 区分形状相同的值，用判别联合让非法状态无法表示，把领域规则写进类型。
date: 2026-10-07
tags: [effect, tutorial, schema, modeling]
category: effect
series: effect-tutorial
seriesOrder: 8
---

上一章的 Schema 还停留在「校验」：数据合不合格。这一章往前走一步，进入**建模**：用 Schema 表达「这个领域里什么样的值才算合法」，并让这个表达同时服务于运行时和类型系统。只引入三个概念：transform、brand、判别联合。

## 要解决的问题：形状对了，含义还是错的

先看几个典型的「形状正确、含义错误」的场景：

- 接口里的金额是字符串 `"19.9"`，内部要用数字计算。外部与内部的表示不一致。
- 函数 `transfer(from: string, to: string)`，两个参数都是字符串，调换顺序编译器不会吭声。用户 ID 和订单 ID 同为 `string`，也可以互相传。
- 一个状态对象 `{ status: string; error?: string; data?: Data }`，既可能「成功却带着 error」，也可能「失败却没有 error」，非法组合有无数种。

这三个问题分别对应三个工具。

## transform：外部表示与内部类型之间的桥

第一类问题是外部形态与内部形态不同。上一章提到 Schema 是双向的，现在要用到这一点了：`Type` 是内部形态，`Encoded` 是外部形态，`transform` 定义两者怎样互相转换。

Effect 内置了常见转换，例如 `Schema.NumberFromString`：外部是字符串，内部是数字。

```ts
import { Schema } from "effect"

Schema.decodeUnknownSync(Schema.NumberFromString)("42")   // 42
Schema.encodeSync(Schema.NumberFromString)(42)             // "42"
```

自己定义转换用 `Schema.decodeTo` 搭配 `SchemaTransformation.transform`，给出解码与编码两个方向：

```ts
import { Schema, SchemaTransformation } from "effect"

const Trimmed = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (s: string) => s.trim(),
      encode: (s: string) => s
    })
  )
)
```

读法是「从 `String` 解码到 `String`，解码时去掉首尾空白，编码时原样输出」。同样的思路可以用来把 ISO 字符串变成日期对象、把逗号分隔字符串变成数组。

这里的心智模型是：**边界之外是外部表示，边界之内是领域表示，Schema 是两者之间唯一的翻译处。** 内部代码拿到的永远是已转换好的值，不需要在业务里写 `new Date(x)` 或 `Number(x)` 这类零散转换。转换要遵守一条纪律：它应该是纯的、可预期的，不要在里面做 IO。

## brand：给形状相同的值不同的身份

第二类问题要用品牌类型（brand）解决。它的思想是：虽然两个值在运行时都是数字，但在类型上它们是不同的东西。

```ts
import { Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
const OrderId = Schema.String.pipe(Schema.brand("OrderId"))

type UserId = typeof UserId.Type
type OrderId = typeof OrderId.Type

declare function cancel(order: OrderId): void
// cancel(someUserId)   // 编译错误：UserId 不能当作 OrderId
```

brand 还可以叠在约束之上，把「通过了校验」这个事实记在类型里：

```ts
const Cents = Schema.Int.pipe(Schema.brand("Cents"))
const Email = Schema.String.check(Schema.isPattern(/^[^@]+@[^@]+$/)).pipe(
  Schema.brand("Email")
)

const price = Cents.make(1999)   // 通过校验才能得到 Cents
```

这样一来，拿到 `Email` 类型的值，就等于拿到一份「它已经被验证过」的证据。函数签名写 `sendTo(email: Email)`，就不必在函数里再检查格式。这是第 7 章「边界校验一次、内部信任类型」的自然延伸：**信任需要有载体，brand 就是载体。**

有一点必须清楚：brand 是**编译期**的名义区分，运行时它还是原来的字符串或数字。它的可靠性取决于「值只能经由 `make` 或解码得到」。如果你在代码里写 `x as Email`，就绕过了所有保证。所以项目里要守住一条线：构造品牌值只能走 Schema，不能手写断言。

## 判别联合：让非法状态无法表示

第三类问题是状态建模。把 `{ status; error?; data? }` 改成一组各自带标签的结构，每个变体只含自己合法的字段：

```ts
import { Schema } from "effect"

const LoadState = Schema.Union([
  Schema.TaggedStruct("Loading", {}),
  Schema.TaggedStruct("Success", { data: Schema.String }),
  Schema.TaggedStruct("Failure", { message: Schema.String })
])

type LoadState = typeof LoadState.Type

const render = (r: LoadState) => {
  switch (r._tag) {
    case "Loading": return "..."
    case "Success": return r.data      // 此处 r 一定有 data
    case "Failure": return r.message   // 此处 r 一定有 message
  }
}
```

`Schema.TaggedStruct` 为每个变体注入一个 `_tag` 字段，`Schema.Union` 把它们并起来。`switch` 里 TypeScript 会据 `_tag` 自动收窄类型，漏掉一种变体时（配合穷尽检查）编译器会提醒你。「成功却带着 error」这种组合，在类型里根本写不出来。

这和第 5 章的 `TaggedError` 是同一个套路：`_tag` 是判别字段，`catchTag` 在失败上做的事，`switch` 在数据上做。**错误与数据共用同一套「带标签的联合」代数。** 第 5 章提到的 `Schema.TaggedError` 就是把这套带标签的结构用在错误上：字段由 Schema 描述，所以错误也能编码、解码，适合跨进程传输。

枚举式的取值用 `Schema.Literals`：

```ts
const Role = Schema.Literals(["admin", "member", "guest"])
// 解码时只接受这三个字符串之一
```

一个判断：当你发现自己在写「字段 A 只有在字段 B 为某值时才有意义」，就该把它拆成联合了。可选字段越堆越多，往往是联合的信号。

## 三者合起来

假设要建模一笔订单：金额用 `Cents`（brand），创建时间在传输中是字符串、内部是日期（transform），状态用判别联合（`Pending` / `Paid` / `Refunded`，各带自己的字段）。解码一次，得到的就是一个所有字段都有含义、所有状态都合法的值；此后整个代码库只和这个领域类型打交道。Schema 既是边界的校验器，又是领域的词汇表。

## 常见误区

- **把 brand 当成运行时保证。** 它只是类型层的标记，`as` 一下就破。运行时的保证来自 `make` 与解码里的校验。
- **在 transform 里做 IO 或有副作用的事。** 转换应该是纯映射。需要查库校验的规则不属于 Schema 的转换。
- **用一堆可选字段代替联合。** 字段的组合爆炸，非法状态随之爆炸。
- **用 `string` 代替 `Literals`。** 能取的值明明有限，却声明成任意字符串，等于放弃了穷尽检查。
- **给每个字符串都加 brand。** 品牌是为了防止真正会混淆、混淆代价高的值（各类 ID、金额单位）。滥用只会增加噪音。
- **在内部随处做转换。** 外部与内部的转换应当集中在 Schema 里，而不是分散在业务代码中。

## 小结

transform 负责外部表示与内部类型的互转，brand 把「已验证」「不可混用」写进类型，判别联合让非法状态无从表示。三者共同的方向是：**把规则从注释和约定，搬到类型和 Schema 里。**

Part 2 到此结束：我们能描述「怎样失败」（第 5、6 章），也能描述「数据长什么样」（第 7、8 章）。Part 3 转向结构问题：程序里的各个部分怎样互相依赖。下一章从服务（service）开始，见 [第 9 章](/articles/effect-tutorial-09-services)。

## 延伸阅读

- [Effect Schema 的判别联合：TaggedUnion](/articles/effect-schema-tagged-union)
- [Effect Schema：在边界处解码数据](/articles/effect-schema-at-the-boundary)
- [Effect Schema 工具链](/articles/effect-schema-toolchain)
