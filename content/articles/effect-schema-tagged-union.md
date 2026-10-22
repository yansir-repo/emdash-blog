---
title: "Effect Schema.TaggedUnion：用判别联合建模领域状态机"
description: "用 Effect v4 的 Schema.TaggedUnion 与 toTaggedUnion 定义判别联合，自带 match、guards 和穷尽检查；对比 Class、Opaque 与 Union 的取舍，并用它写出一个订单状态机。"
date: 2026-10-22
category: effect
tags: [effect, advanced, schema]
---

订单有「草稿、已支付、已发货、已取消」四个状态，每个状态携带的数据不一样：已发货才有运单号，已取消才有原因。最常见的建模方式是一个大对象加一个 `status: string`，再把所有状态专属字段都标成可选。这种模型能表达大量非法状态，比如「草稿却有运单号」，而且每处使用都要靠判空来猜现在是哪个状态。

判别联合（discriminated union）把这件事交给类型系统：每个状态是一个独立的对象类型，由 `_tag` 区分，非法组合根本写不出来。Effect v4 的 Schema 把「联合的定义、解码、模式匹配、类型守卫」做成了同一份东西。这篇讲怎么用，以及什么时候该换 Class 或 Opaque。代码在 effect 4.0.5、strict 加 `exactOptionalPropertyTypes` 下编译并运行过，相关 API 的 JSDoc 都是 `@stability stable`。

## Schema.TaggedUnion：从零定义

`Schema.TaggedUnion` 接收一个「标签到字段」的记录，每个键成为 `_tag` 的字面量：

```ts
import { Schema } from "effect"

export const Order = Schema.TaggedUnion({
  Draft: { items: Schema.Array(Schema.String) },
  Paid: { items: Schema.Array(Schema.String), paidAt: Schema.DateTimeUtcFromString },
  Shipped: { items: Schema.Array(Schema.String), trackingNo: Schema.NonEmptyString },
  Cancelled: { reason: Schema.String }
})
export type Order = typeof Order.Type
```

返回值本身是一个 Schema，可以直接 `decodeUnknownSync`、`encodeSync`，同时多了几个工具：`tag`（判别字段名，固定是 `"_tag"`）、`cases`（每个成员的 Schema）、`guards`、`isAnyOf`、`match`、`matchOrElse`。

### match：穷尽检查

```ts
const label = Order.match({
  Draft: (o) => `draft ${o.items.length}`,
  Paid: (o) => `paid ${o.paidAt}`,
  Shipped: (o) => `shipped ${o.trackingNo}`,
  Cancelled: (o) => `cancelled ${o.reason}`
})
const d: Order = { _tag: "Draft", items: ["a"] }
console.log(label(d)) // draft 1

// @ts-expect-error 少了 Cancelled，编译不过
Order.match({ Draft: () => 1, Paid: () => 1, Shipped: () => 1 })
```

`match` 有两种调用形式：只传 `cases` 得到一个函数，传 `(value, cases)` 直接求值。每个分支里的参数类型已经收窄到对应成员，所以 `Shipped` 分支里能直接用 `o.trackingNo`。**少写任何一个分支都是编译错误**，这是它相对于 `switch` 加 `default` 的价值：以后新增一个状态，所有 `match` 调用点都会报错，逼你逐个处理。

不想穷尽时用 `matchOrElse`，已写出的分支精确匹配，其余走兜底：

```ts
const pay = (o: Order, at: typeof Order.cases.Paid.Type["paidAt"]): Order =>
  Order.matchOrElse(
    o,
    { Draft: (x) => ({ _tag: "Paid" as const, items: x.items, paidAt: at }) },
    (x) => x
  )
```

这就是一个状态转换函数：只有 `Draft` 能转成 `Paid`，其它状态原样返回。要把「非法转换」当成错误而不是静默忽略，让分支返回 `Result.fail`，下面的状态机例子就是这样写的，错误建模可以参考[类型化错误那篇](/articles/effect-typed-errors)。

### guards：运行时检查，不只是 `_tag`

```ts
console.log(Order.guards.Draft(d))                         // true
console.log(Order.guards.Paid(d))                          // false
console.log(Order.guards.Draft({ _tag: "Draft" }))         // false，缺 items
console.log(Order.isAnyOf(["Paid", "Shipped"])(d))         // false
```

注意第三行：`guards.Draft` 校验的是整个成员的结构，不是只看 `_tag`，所以 `{ _tag: "Draft" }` 缺了 `items` 返回 `false`。`isAnyOf` 则是只按标签判断的收窄工具，适合「已支付或已发货才允许退款」这类规则。

### 解码失败长什么样

```ts
try {
  Schema.decodeUnknownSync(Order)({ _tag: "Nope" })
} catch (e) {
  console.log(String(e))
}
```

我运行得到的错误信息是 `Expected { readonly "_tag": "Draft", ... } | { readonly "_tag": "Paid", ... } | ...`，列出了所有合法成员。这个信息对内部排查够用，但对外返回前建议自己格式化。

## toTaggedUnion：给已有的联合加工具

已经有成员 Schema，或者判别字段不叫 `_tag`，就用 `Schema.toTaggedUnion(key)` 给普通 `Union` 加上同样的工具：

```ts
import { Schema } from "effect"

const A = Schema.TaggedStruct("A", { v: Schema.Number })
const B = Schema.TaggedStruct("B", { s: Schema.String })
const U = Schema.Union([A, B]).pipe(Schema.toTaggedUnion("_tag"))
console.log(U.match({ _tag: "A", v: 1 }, { A: (a) => a.v, B: (b) => b.s.length })) // 1
console.log(U.discriminants) // [ 'A', 'B' ]

// 判别字段可以是任意名字，比如 DOM 事件常见的 kind
const UiEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("click"), x: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("key"), code: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))
console.log(UiEvent.match({ kind: "key", code: "a" }, { click: (c) => c.x, key: (k) => k.code })) // a

// 判别值重复：编译期报错，运行时也会抛
try {
  // @ts-expect-error 判别值重复
  Schema.Union([A, A]).pipe(Schema.toTaggedUnion("_tag"))
} catch (e) {
  console.log(String(e)) // Error: Duplicate discriminant: A
}

// 嵌套联合会被展平
const Nested = Schema.Union([U, Schema.TaggedStruct("C", {})]).pipe(Schema.toTaggedUnion("_tag"))
console.log(Nested.discriminants) // [ 'A', 'B', 'C' ]
```

要点：判别值必须唯一，重复会在编译期被拒绝，并且运行时也会抛 `Duplicate discriminant`；嵌套的 `Union` 会被展平成同一层。`TaggedUnion` 与 `toTaggedUnion` 的区别只在起点：前者从字段记录一次生成，后者增强已有联合。需要保留各成员的独立命名（比如要单独导出 `Paid` 的 Schema 给别处复用），用后者；一次性的小联合用前者。

## Class、Opaque、Union 怎么选

联合的成员不一定是纯数据结构。v4 里有三个常见的「给结构加身份」的工具，它们的差别比名字看起来大。

### Schema.Class 与 TaggedClass：带行为的实例

```ts
import { Schema } from "effect"

class Circle extends Schema.TaggedClass<Circle>()("Circle", { radius: Schema.Number }) {
  area() {
    return Math.PI * this.radius ** 2
  }
}
class Rect extends Schema.TaggedClass<Rect>()("Rect", { w: Schema.Number, h: Schema.Number }) {}

const Shape = Schema.Union([Circle, Rect]).pipe(Schema.toTaggedUnion("_tag"))
const s = Schema.decodeUnknownSync(Shape)({ _tag: "Circle", radius: 1 })
console.log(s, Shape.match(s, { Circle: (c) => c.area(), Rect: (r) => r.w * r.h }))
// Circle { _tag: 'Circle', radius: 1 } 3.141592653589793
console.log(Shape.guards.Circle(new Circle({ radius: 1 }))) // true
console.log(Shape.guards.Circle({ _tag: "Circle", radius: 1 })) // false
```

`TaggedClass` 解码后得到的是真正的类实例，可以有方法，`match` 里直接调用 `c.area()`。代价在最后一行：`guards.Circle` 对 Class 成员是 `instanceof` 语义，**结构相同的普通对象不通过**。所以带 Class 的联合，数据必须经过 `decode` 或 `new` 才能进入，不能手写对象字面量冒充。

### Schema.Opaque：只改类型身份，不加运行时

```ts
import { Schema } from "effect"

class Money extends Schema.Opaque<Money>()(
  Schema.Struct({ amount: Schema.Int, currency: Schema.Literals(["CNY", "USD"]) })
) {}
class Usd extends Schema.Opaque<Usd, { readonly _brand: "Usd" }>()(
  Schema.Struct({ amount: Schema.Int })
) {}

const m = Schema.decodeUnknownSync(Money)({ amount: 1, currency: "CNY" })
console.log(m, m instanceof Money) // { amount: 1, currency: 'CNY' } false

// 不带 Brand：结构相同的字面量仍然可以赋值
const takesMoney = (x: Money) => x.amount
takesMoney({ amount: 1, currency: "CNY" })

// 带 Brand：字面量被拒绝，必须经由 Usd.make 或解码得到
const takesUsd = (x: Usd) => x.amount
// @ts-expect-error 缺少品牌
takesUsd({ amount: 1 })
takesUsd(Usd.make({ amount: 1 }))
```

`Opaque` 的运行时值是普通对象，`instanceof` 为 `false`，它改变的只是 TypeScript 里的类型名。有两点要明确：

1. 默认的 `Opaque<Money>()` **不提供名义类型**，结构相同的字面量照样能赋给 `Money`，真想隔离要像 `Usd` 那样传第二个类型参数当 Brand。
2. 它**只能包 `Struct`**：`class X extends Schema.Opaque<X>()(Schema.String)` 会得到 `Base constructor return type 'string' is not an object type` 的编译错误，我还试了 `Union` 包两个 `Struct`，同样不行。根源是 TypeScript 只允许 `class extends` 一个对象类型。要给原始类型加名义身份，用 `Schema.brand`。

### 取舍

我的选择标准只有一个问题：**运行时需要这个身份吗？**

- 状态只是数据、要序列化、要被 `match` 穷尽：`Schema.TaggedUnion`。这是状态机的默认选择。
- 成员需要方法、需要 `instanceof`：`Class` 或 `TaggedClass`，再用 `toTaggedUnion` 串起来。
- 只想在类型层面把两种结构相同的数据隔开，运行时仍然是纯对象：`Opaque` 加 Brand。
- 单个原始类型的名义化：`brand`，不是 `Opaque`。

多数领域状态机，我会先用 `TaggedUnion`，因为它的值是可以直接 `JSON.stringify` 的普通对象，测试里也能直接写字面量。只有当某个状态确实长出了行为，才把那一个成员升级成 Class，联合的其它成员不用动。

## 用判别联合写一个状态机

把前面的东西合起来：状态是 `Order`，事件是另一个 `TaggedUnion`，转换是一个 `match` 嵌套 `matchOrElse` 的纯函数。

```ts
import { Result, Schema } from "effect"

const Event = Schema.TaggedUnion({
  Pay: { at: Schema.DateTimeUtcFromString },
  Ship: { trackingNo: Schema.NonEmptyString },
  Cancel: { reason: Schema.String }
})
type Event = typeof Event.Type

const next = (o: Order, e: Event): Result.Result<Order, string> =>
  Event.match(e, {
    Pay: (ev) =>
      Order.guards.Draft(o)
        ? Result.succeed<Order>({ _tag: "Paid", items: o.items, paidAt: ev.at })
        : Result.fail(`cannot pay from ${o._tag}`),
    Ship: (ev) =>
      Order.guards.Paid(o)
        ? Result.succeed<Order>({ _tag: "Shipped", items: o.items, trackingNo: ev.trackingNo })
        : Result.fail(`cannot ship from ${o._tag}`),
    Cancel: (ev) =>
      Order.isAnyOf(["Draft", "Paid"])(o)
        ? Result.succeed<Order>({ _tag: "Cancelled", reason: ev.reason })
        : Result.fail(`cannot cancel from ${o._tag}`)
  })

const draft: Order = { _tag: "Draft", items: ["book"] }
const ev = Schema.decodeUnknownSync(Event)({ _tag: "Pay", at: "2026-10-22T00:00:00Z" })
console.log(next(draft, ev))
console.log(next({ _tag: "Cancelled", reason: "x" }, ev))
```

这里两层分发都是穷尽的：事件少处理一种，`Event.match` 报错；状态加一种，凡是对 `Order` 做 `match` 的地方报错。「当前状态是否允许这个事件」写成 `guards` 加三元，非法转换变成显式的失败值，状态机的转换表一眼就能读出来。事件同样来自 `Schema.decodeUnknownSync`，所以从外部进来的事件和落库的状态走的是同一套校验，这也正是[边界解码](/articles/effect-schema-at-the-boundary)的用法。

## 状态机也是一份可导出的契约

`TaggedUnion` 的返回值是普通 Schema，所以[上一篇](/articles/effect-schema-toolchain)的整套投影都能直接用。我对一个只含 `Draft` 和 `Paid` 的子集试过：`Schema.toCodecJson` 编码后是 `{"_tag":"Paid","items":[],"paidAt":"2026-10-22T00:00:00.000Z"}`，`toJsonSchemaDocument` 生成的是每个成员一个 `object` 的 `anyOf`，`_tag` 是单值 `enum`，`toFormatter` 能直接把状态打成日志。

也就是说，状态定义一旦写好，落库格式、给前端的 JSON Schema、审计日志格式都是同一个来源。新增一个状态时，三者同时更新，`match` 的编译错误会告诉你还有哪些业务分支没处理。

## 小结

判别联合的价值是让非法状态不可表示：每个状态一个类型，由 `_tag` 区分。`Schema.TaggedUnion` 一次给出解码、`match`、`guards`、`isAnyOf` 和 `matchOrElse`，其中 `match` 少一个分支就编译失败；`toTaggedUnion` 给已有联合补上同样的工具，判别字段名可以自定，判别值重复会被拒绝。

`Class` 的成员带方法但守卫是 `instanceof` 语义；`Opaque` 只改类型身份，默认不是名义类型，而且只能包 `Struct`。默认用 `TaggedUnion` 建模状态机，成员确实需要行为再升级成 Class。下一篇讲怎么给这些 Schema 写属性测试。
