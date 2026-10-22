---
title: "Effect Optic：不可变数据的深层读写，以及 check 到底在什么时候生效"
description: 讲清 Effect v4 新增的 Optic 模块：Iso、Lens、Prism、Traversal 的层级与用法，和展开运算符、Schema 的分工，以及 check 在写回时并不校验的细节。
date: 2026-10-22
category: effect
tags: [effect, advanced]
---

只要状态是不可变的，迟早会写出这种代码：`{ ...order, address: { ...order.address, city } }`。一层还好，三层之后就是一串展开运算符，再加上「只改数组里满足条件的元素」「只改联合类型里某个分支」，样板代码的体积开始超过业务逻辑。

v4 把这个问题的标准答案放进了 effect 本体：`Optic` 模块（`@stability stable`，v4.0.0 引入）。这篇文章讲它的类型层级、日常用法、和展开运算符的取舍，以及一个很容易想当然的细节：**挂在 optic 上的 Schema check，写回时并不会校验**。

文中所有代码在 effect 4.0.5、`strict` 加 `exactOptionalPropertyTypes` 下编译并实际运行过。

## 一个 optic 是什么

Optic 描述「在一个值 `S` 里，焦点 `A` 在哪里」。它是一个纯数据：不持有状态、不修改入参，读和写都返回新值。不同的 optic 种类，区别只在于焦点是否一定存在、写回是否一定成功。

- `Iso<S, A>`：无损、可逆的转换，`get` 和 `set` 都不会失败。例如元和分、摄氏和华氏
- `Lens<S, A>`：焦点一定存在，`get(s)` 总能成功，写回需要原来的 `S`。例如结构体字段
- `Prism<S, A>`：焦点可能不存在，但 `set(a)` 可以凭空构造出 `S`。例如联合类型的某个分支、`Option.some`
- `Optional<S, A>`：焦点可能不存在，写回也可能失败。其他几种都是它的特例
- `Traversal<S, A>`：本质是 `Optional<S, ReadonlyArray<A>>`，焦点是多个值

层级关系是：`Iso` 同时是 `Lens` 和 `Prism`，`Lens` 与 `Prism` 都是 `Optional`。组合时结果取两者中较弱的那个：Lens 加 Prism 得到 Optional，Iso 加 Iso 仍是 Iso。这条规则由重载签名在类型层面保证，不需要你手动标注。

入口只有一个：`Optic.id<S>()`，返回恒等 Iso。之后用链式方法一路向下钻。

## 最小例子：key、get、replace、modify

```ts
import { Optic } from "effect"

type Address = { readonly city: string; readonly zip: string }
type Order = {
  readonly id: string
  readonly address: Address
  readonly note?: string
}

const order: Order = { id: "o1", address: { city: "Hangzhou", zip: "310000" } }

const _city = Optic.id<Order>().key("address").key("city")

console.log(_city.get(order)) // Hangzhou
console.log(_city.replace("Shanghai", order).address.city) // Shanghai
console.log(_city.modify((s) => s.toUpperCase())(order).address.city) // HANGZHOU
console.log(order.address.city) // Hangzhou，原值不变
```

几个约定值得记住。optic 变量按惯例用 `_` 前缀，和值区分开。`modify(f)` 返回的是 `(s: S) => S`，所以能直接塞进 `pipe` 或 `Array.map`。模块也提供 data-first 与 data-last 两种形式的顶层函数：`Optic.get`、`Optic.replace`、`Optic.modify`、`Optic.getResult`、`Optic.getAll`、`Optic.modifyAll`，和方法等价，只是风格不同。

我实际验证过结构共享：改 `x.y` 之后，没被触及的兄弟分支保持引用相等，被改的路径上的对象是新的。所以它在 React 这类依赖引用比较的场景里是安全的。

## Traversal：批量改数组里的元素

`.forEach` 把焦点从「整个数组」下放到「每个元素」，参数是一个函数，接收元素级的 optic，返回你要聚焦的子 optic。

```ts
import { Optic, Schema } from "effect"

type Item = { readonly sku: string; readonly qty: number }
type Cart = { readonly items: ReadonlyArray<Item> }

const cart: Cart = { items: [{ sku: "a", qty: 1 }, { sku: "b", qty: 0 }, { sku: "c", qty: 3 }] }

const _qty = Optic.id<Cart>()
  .key("items")
  .forEach((item) => item.key("qty").check(Schema.isGreaterThan(0)))

console.log(Optic.getAll(_qty)(cart)) // [ 1, 3 ]
console.log(_qty.modifyAll((n) => n + 10)(cart).items.map((i) => i.qty)) // [ 11, 0, 13 ]
```

这里 `check` 起的作用是**过滤**：qty 为 0 的元素不满足 `isGreaterThan(0)`，根本不在焦点里，所以 `getAll` 看不到它，`modifyAll` 也不会动它。这是 `check` 在读侧的语义，下一节会讲它在写侧完全不同。

Traversal 还有两个细节。其一，`getAll` 返回的是新的可变数组，可以放心 `push`。其二，Traversal 的写回要求「值的个数和读出来的个数一致」，否则失败；通过 `modifyAll` 这类逐元素变换使用时不会碰到这个限制，只有你直接用 `replaceResult` 往 Traversal 里塞整个数组时才要注意。

## Prism 与 Optional：联合类型和缺失的键

联合类型分支用 `.tag`（按 `_tag` 窄化）或 `.refine`（任意类型守卫）。焦点不存在时，`replace` 原样返回输入，永不抛错；想知道到底失败没有，用 `getResult` 或 `replaceResult`，拿到 `Result` 和结构化的 `SchemaIssue`。

```ts
import { Optic, Option, Result } from "effect"

type Pay =
  | { readonly _tag: "Card"; readonly last4: string }
  | { readonly _tag: "Cash"; readonly amount: number }

const _last4 = Optic.id<Pay>().tag("Card").key("last4")

const cash: Pay = { _tag: "Cash", amount: 1 }
console.log(_last4.replace("0000", cash)) // { _tag: 'Cash', amount: 1 }，原样返回
console.log(_last4.replace("0000", { _tag: "Card", last4: "1111" })) // { _tag: 'Card', last4: '0000' }
console.log(Result.isFailure(_last4.replaceResult("0000", cash))) // true

// 可选字段：写入 undefined 表示删除该键
type Note = { readonly note?: string }
const _note = Optic.id<Note>().optionalKey("note")
console.log(_note.replace(undefined, { note: "hi" })) // {}
console.log(_note.replace("x", {})) // { note: 'x' }

// 记录里的键：.at 要求键必须存在
const _x = Optic.id<Record<string, number>>().at("x")
console.log(Result.isFailure(_x.replaceResult(1, {}))) // true
console.log(_x.replace(1, {})) // {}，静默不变

// 与 Option 组合：some() 是一个 Prism
const _inner = Optic.id<{ readonly v: Option.Option<number> }>().key("v").compose(Optic.some())
console.log(_inner.replace(3, { v: Option.none() })) // v 仍是 None
console.log(_inner.replace(3, { v: Option.some(1) })) // v 变为 Some(3)
```

这段里最容易踩的是 `replace` 的静默。它的设计是「失败就保持不变」，适合 UI 状态更新这类「没有就算了」的场景；但如果你在写业务校验，静默等于吞错。我的规则是：**写入路径只要有可能不存在，就用 `replaceResult`，把失败当作值处理**。

`.key` 与 `.optionalKey` 的区别也要分清：在类型允许 `string | undefined` 的字段上，`.key("note")` 写入 `undefined` 会留下 `note: undefined` 这个键（我跑过，`"note" in result` 为 true）；`.optionalKey` 写入 `undefined` 才是真的删键。在 `exactOptionalPropertyTypes` 下，这才是可选字段的正确语义。

## check：读时过滤，写时不管

这是本篇最重要的一节。`.check(...)` 接受 Schema 的 check（`Schema.isGreaterThan`、`Schema.isMinLength`、`Schema.isPattern` 等），官方 JSDoc 的描述是：`getResult` 在 check 失败时失败，`set` 原样透传。我实测确认了这一点：

```ts
import { Optic, Result, Schema, SchemaIssue } from "effect"

type Order = { readonly address: { readonly zip: string } }
const order: Order = { address: { zip: "310000" } }

const _zip = Optic.id<Order>()
  .key("address")
  .key("zip")
  .check(Schema.isPattern(/^\d{6}$/))

// 读侧：不合格的值读不出来
const bad: Order = { address: { zip: "x" } }
const read = _zip.getResult(bad)
if (Result.isFailure(read)) {
  console.log(SchemaIssue.makeFormatterDefault()(read.failure))
  // Expected a string matching the RegExp ^\d{6}$
}

// 写侧：非法值照样写进去，replaceResult 也是 Success
const written = _zip.replaceResult("12", order)
console.log(written._tag) // Success
console.log(_zip.replace("12", order).address.zip) // 12
```

也就是说，「在 focus 上挂一个 Schema check，就能保证写回的值合法」是**错误的**直觉。`check` 的角色是「这个焦点只在满足条件时才存在」，这对 Traversal 里按条件筛元素非常有用，但它不是写入守卫。

要在写回时拒绝非法值，有两条可行的路。

第一条，写后复核：写完再用同一个 optic 读一遍，读不出来就说明写入的值不满足条件。

```ts
import { Optic, Result, Schema } from "effect"

type Order = { readonly address: { readonly zip: string } }
const order: Order = { address: { zip: "310000" } }

const _zip = Optic.id<Order>().key("address").key("zip").check(Schema.isPattern(/^\d{6}$/))

const next = _zip.replace("12", order)
console.log(Result.isFailure(_zip.getResult(next))) // true：写入的值不满足条件
```

第二条，用 `makeOptional` 自己定义带校验的 setter，把「校验」收进 optic 本身，这样所有调用方共用同一份规则。这里用 `SchemaParser.decodeUnknownResult` 拿到 `Result<_, Issue>`，正好对上 `makeOptional` 要求的错误类型：

```ts
import { Optic, Result, Schema, SchemaIssue, SchemaParser } from "effect"

type Order = { readonly address: { readonly zip: string } }
const order: Order = { address: { zip: "310000" } }

const validated = <S, A>(optic: Optic.Optional<S, A>, schema: Schema.Codec<A, A>): Optic.Optional<S, A> =>
  Optic.makeOptional(optic.getResult, (a, s) =>
    Result.flatMap(SchemaParser.decodeUnknownResult(schema)(a), (ok) => optic.replaceResult(ok, s)))

const Zip = Schema.String.check(Schema.isPattern(/^\d{6}$/))
const _zip = validated(Optic.id<Order>().key("address").key("zip"), Zip)

const bad = _zip.replaceResult("12", order)
if (Result.isFailure(bad)) console.log(SchemaIssue.makeFormatterDefault()(bad.failure))
// Expected a string matching the RegExp ^\d{6}$
console.log(_zip.replace("12", order).address.zip) // 310000：replace 保持原值
console.log(_zip.replace("100000", order).address.zip) // 100000
```

注意最后两行：`replace` 在校验失败时保持原值，和前面说的「失败即不变」一致；要看到失败原因必须走 `replaceResult`。

## 和 Schema 的关系：toIso 才是写入校验

Schema 与 Optic 有两处连接。一是 `Schema.Optic<T, Iso>` 这个接口：大部分原语 schema 都实现了它，带有 `Iso` 类型位，且解码编码不需要 Effect 服务。二是 `Schema.toIso`、`Schema.toIsoSource`、`Schema.toIsoFocus` 三个函数，把一个 schema 变成 Iso optic。

`Schema.toIso(schema)` 最有意思：通过它读是**编码**，通过它写是**解码**。所以写回会走完整的 schema 校验，并且产出的是真正的 class 实例。

```ts
import { Schema } from "effect"

class Account extends Schema.Class<Account>("Account")({
  name: Schema.String,
  balance: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

const a = new Account({ name: "a", balance: 10 })
const _balance = Schema.toIso(Account).key("balance")

const b = _balance.replace(5, a)
console.log(b instanceof Account, b.balance) // true 5

try {
  _balance.replace(-1, a)
} catch (e) {
  console.log((e as Error).message) // Schema validation failed
}
```

这里有两个坑，都是我跑出来的。

1. 校验失败是**同步抛异常**（`Error`，`cause` 里放 `SchemaIssue`），连 `replaceResult` 也一样抛，不会返回 `Result.Failure`。JSDoc 的 Gotchas 里明确提到了这一点：这条路径是同步的，涉及失败、异步或依赖服务的转换时会抛。所以它适合在边界处用 try/catch 或 `Effect.try` 包一层，不适合当作返回值式的校验。
2. 直接对 class 实例用 `Optic.id<Account>().key("balance").replace(...)` 会抛 `Cannot clone object with non-Object constructor or null prototype`，因为 `.key` 的写回靠浅克隆普通对象。读（`get`）没问题，写不行。对 class 值请走 `Schema.toIso(...)`，或者先转成普通结构。

## 什么时候用，什么时候继续用展开运算符

对比手写展开：

- 单层字段更新：`{ ...s, a }` 更直接，没有理由引入 optic
- 两层以内、路径固定：展开仍然可读，差别不大
- 三层及以上，或者路径要作为值传来传去：optic 的价值开始出现，路径只写一次，读写共用
- 数组里按条件改元素、联合类型的某个分支、`Option` 里面的值：这是展开最难写对的地方，也是 optic 最划算的地方
- 需要把「怎么定位」和「怎么改」拆开，比如 reducer 里用同一个 `_cart` 路径做读、写、校验：optic 是更好的抽象

代价也要说清：它是又一层间接性，类型报错有时不如展开直观；class 实例写回要绕道 Schema；`replace` 的静默在业务校验里是隐患。我的取舍是：状态树深、变换种类多的地方集中放一组 optic 模块，其他地方不碰。

## 小结

- Optic 是 v4 新增的稳定模块，层级是 Iso、Lens、Prism、Optional、Traversal，组合结果取最弱的那一种
- `Optic.id<S>()` 起手，`.key`、`.optionalKey`、`.at`、`.tag`、`.refine`、`.forEach` 向下钻，`replace`、`modify`、`modifyAll`、`getAll` 收尾
- 焦点不存在时 `replace` 与 `modify` 静默不变；要拿到失败原因，用 `getResult` 与 `replaceResult`
- `.check(...)` 是读侧过滤，写回时透传，不校验。要写入校验，用写后复核，或者 `makeOptional` 自定义 setter
- `Schema.toIso` 的写回会走解码校验并保留 class 实例，但失败是同步抛异常
- class 实例上的 `.key` 写回会抛错，两层以内的简单更新继续用展开运算符就好
