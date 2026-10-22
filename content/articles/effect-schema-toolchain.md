---
title: "Effect Schema 工具链：一份定义，派生校验、JSON Schema、Diff 与更多"
description: "Effect v4 的 Schema 一份定义可派生 Standard Schema、JSON 编解码器、JSON Schema、Equivalence、Formatter 与 JSON Patch，并讲清默认值的坑。"
date: 2026-10-22
tags: [effect, effect-advanced, schema, json-schema, standard-schema]
category: effect
---

[上一篇 Schema 的文章](/articles/effect-schema-at-the-boundary)讲的是边界解码：`unknown` 进来，类型化的值出去。这篇讲另一半价值：**一份 Schema 定义，可以机械地派生出一整套周边能力**。

很多团队的现状是：TypeScript 类型一份、运行时校验一份、OpenAPI 或 JSON Schema 一份、测试里的相等比较一份、日志格式化再一份。五份定义靠人肉同步，迟早漂移。Effect v4 的做法是把这些都当作 Schema 的「投影」，定义只写一次，其它都是 `Schema.toXxx` 函数。

文中代码在 effect 4.0.5、TypeScript strict 加 `exactOptionalPropertyTypes` 下编译并运行过。本文涉及的导出函数在 JSDoc 里标注为 `@stability stable`，其中 `toStandardJSONSchemaV1` 在 JSDoc 里写明是实验性的，我没有展开。

## 一份定义，六种投影

先定义一个 `Todo`，后面所有例子都基于它：

```ts
import { Effect, Schema } from "effect"

export const Todo = Schema.Struct({
  id: Schema.Int,
  title: Schema.NonEmptyString,
  done: Schema.Boolean,
  due: Schema.optionalKey(Schema.DateTimeUtcFromString),
  priority: Schema.Literals(["low", "high"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("low" as const))
  )
}).annotate({ identifier: "Todo" })

export type Todo = typeof Todo.Type
```

下面这一段把六种投影依次跑一遍，注释里是我实际运行得到的结果。

```ts
import { Schema } from "effect"

// 1. Standard Schema：交给只认 Standard Schema 的消费方
const standard = Schema.toStandardSchemaV1(Todo)
const result = standard["~standard"].validate({ id: 1.5, title: "", done: false })
if (!(result instanceof Promise) && result.issues) {
  console.log(result.issues.map((i) => i.message))
  // ["Expected an integer", "Expected a value with a length of at least 1"]
}

// 2. JSON 编解码器
const Event = Schema.Struct({
  at: Schema.Date,
  total: Schema.BigInt,
  tags: Schema.ReadonlySet(Schema.String)
})
const json = Schema.toCodecJson(Event)
const wire = Schema.encodeSync(json)({ at: new Date(0), total: 10n, tags: new Set(["a", "b"]) })
console.log(JSON.stringify(wire))
// {"at":"1970-01-01T00:00:00.000Z","total":"10","tags":["a","b"]}
console.log(Schema.decodeUnknownSync(json)(wire))
// { at: 1970-01-01T00:00:00.000Z, total: 10n, tags: Set(2) { 'a', 'b' } }

// 3. JSON Schema（draft-2020-12）
const doc = Schema.toJsonSchemaDocument(Todo)
console.log(doc.dialect, JSON.stringify(doc.definitions["Todo"]))

// 4. Equivalence 与 Formatter
const eq = Schema.toEquivalence(Todo)
const fmt = Schema.toFormatter(Todo)
const a: Todo = { id: 1, title: "write", done: false, priority: "low" }
console.log(eq(a, { ...a }), eq(a, { ...a, done: true })) // true false
console.log(fmt(a)) // { "id": 1, "title": "write", "done": false, "priority": "low" }

// 5. JSON Patch
const differ = Schema.toDifferJsonPatch(Schema.toCodecJson(Todo))
const patch = differ.diff(a, { ...a, done: true, priority: "high" })
console.log(JSON.stringify(patch))
// [{"op":"replace","path":"/done","value":true},{"op":"replace","path":"/priority","value":"high"}]
console.log(differ.patch(a, patch))
// { id: 1, title: 'write', done: true, priority: 'high' }
```

逐个说它们各自解决什么。

### toStandardSchemaV1：对外的最小公约数

[Standard Schema](https://standardschema.dev) 是一个很小的接口：对象上有 `~standard.validate`，返回值要么是 `{ value }`，要么是 `{ issues }`。表单库、路由库、环境变量库越来越多地只依赖这个接口，而不依赖具体的校验库。

`toStandardSchemaV1(schema)` 返回的是 `StandardSchemaV1 & S`，也就是说它**仍然是一个 Schema**，你可以继续把它传给 `decodeUnknownSync`。不需要为了兼容外部库在项目里维护两个对象。

三个边界要知道。第一，签名要求 `ConstraintDecoder<unknown>`，也就是解码不能依赖 Effect 服务，需要 `Context` 的 Schema 传不进去。第二，`validate` 的返回类型允许是 Promise，我这里的例子是同步返回，所以先用 `instanceof Promise` 收窄。第三，`issues[].message` 来自 Schema 默认格式化，要改成自己的文案，用第二个参数里的 `leafHook`、`checkHook`。

### toCodecJson：把「JSON 里能放什么」说清楚

`JSON.stringify` 遇到 `Date` 会转字符串，遇到 `BigInt` 直接抛错，遇到 `Set` 得到 `{}`。`toCodecJson` 给出的是一个**规范化**的 JSON 形态：`Date` 变 ISO 字符串，`BigInt` 变十进制字符串，`ReadonlySet` 变数组。解码方向反过来还原，类型和 `Schema` 的 `Type` 一致。

这个编解码器适合做存储和跨进程传输的统一口径：写的一端 `encode`，读的一端 `decode`，两边不用各自发明序列化约定。

有一个细节值得记住：对 `Schema.optional(Schema.String)` 这种允许 `undefined` 的字段，JSON 里没有 `undefined`，规范形态是 `null`。我实际跑过：`{ name: null }` 用 JSON 编解码器可以解成 `{ name: undefined }`，编码回去得到 `{ name: null }`；用原 Schema 解码同样输入则会失败。所以**处理 JSON 输入要用 `toCodecJson(schema)`，不要拿原 Schema 去 `decode` JSON.parse 的结果**。

### toCodecIso 与 toCodecStringTree

这两个是同一个思路的变体，编码侧不同：

- `toCodecIso(schema)` 的 Encoded 是 Schema 的 `Iso` 类型，一个用于无损往返的中间表示。我测过 `Option.none()` 在 Iso 一侧是普通对象 `{ _tag: "None" }`。
- `toCodecStringTree(schema)` 的 Encoded 是 `StringTree`，叶子全是字符串。我测过 `{ id: 1, done: true }` 编码后是 `{ id: "1", done: "true" }`，解码时数字和布尔会从字符串还原。URL 查询串、表单字段、环境变量这类「万物皆字符串」的载体最适合它。

### toJsonSchemaDocument：给非 TypeScript 的世界

`toJsonSchemaDocument(schema)` 返回 draft-2020-12 的文档，`doc.schema` 是入口，`doc.definitions` 里是带 `identifier` 的命名定义。上面的例子里，`priority` 因为有解码默认值，在 JSON Schema 里**不在 `required` 里**，`id`、`title`、`done` 才是必填，这正是调用方需要知道的契约。

关键点是它描述的是 `toCodecJson(schema)` 的 Encoded 一侧，不是任意 `Encoded`。官方 JSDoc 也明确提醒：生成是尽力而为，字符串长度按码点还是 UTF-16 单元、正则 flag 等细节和 Effect 的检查不完全等价，**它适合做预校验，Effect 解码器才是最终裁判**。把它当成「给前端表单、OpenAPI 工具、LLM 工具参数」用的描述就对了，不要当成安全边界。

### toEquivalence 与 toFormatter

`toEquivalence(schema)` 按 Schema 结构递归比较，结果是一个 `(a, b) => boolean`，可以直接用在去重、测试断言、缓存键比较上。需要对某个类型自定义时用 `Schema.overrideToEquivalence`。

`toFormatter(schema)` 把值格式化成可读字符串，递归处理 struct、数组、联合。想让某个类型（比如敏感字段）显示成别的样子，用 `Schema.overrideToFormatter`。这对日志和错误信息很实用：不用再手写 `toString`，也不会漏掉新增字段。

### toDifferJsonPatch：结构化的变更记录

`toDifferJsonPatch(codec)` 接收一个 `Schema.toCodecJson(...)` 这样的 JSON 编解码器，返回带 `diff`、`patch`、`empty` 的 `Differ`。`diff(old, new)` 先把两个值都编码成 JSON，再产出 RFC 6902 的 JSON Patch；`patch(old, patch)` 反过来应用补丁并解码回类型化的值。上面例子里只改了两个字段，补丁就只有两条 `replace`。

用途很直接：审计日志、乐观更新的差量同步、撤销重做。边界也在 JSDoc 里写明了：这个 API 是同步的，涉及异步或依赖服务的转换时会抛异常，所以它适合纯数据 Schema。

## withDecodingDefaultKey：默认值是 Encoded 的 Effect

上面 `Todo` 里用了 `withDecodingDefaultKey`。它给「键缺失时」补默认值，这里有四个坑，我都跑过。

```ts
import { Effect, Schema } from "effect"

// 坑 1：默认值是 Effect，不是 thunk
const Bad = Schema.Struct({
  // @ts-expect-error 需要 Effect，传 () => "member" 编译不过
  role: Schema.String.pipe(Schema.withDecodingDefaultKey(() => "member"))
})
void Bad

// 坑 2：默认值是 Encoded 类型。DateTimeUtcFromString 的 Encoded 是 string
const Stamp = Schema.Struct({
  at: Schema.DateTimeUtcFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("1970-01-01T00:00:00.000Z"))
  )
})
console.log(Schema.decodeUnknownSync(Stamp)({}).at) // DateTime.Utc(1970-01-01T00:00:00.000Z)

const WrongSide = Schema.DateTimeUtcFromString.pipe(
  // @ts-expect-error 传 Type（Date）会被拒绝
  Schema.withDecodingDefaultKey(Effect.succeed(new Date()))
)
void WrongSide

// 想直接给 Type 一侧的值：用 withDecodingDefaultTypeKey
const TypeSide = Schema.Struct({
  at: Schema.DateTimeUtcFromString.pipe(
    Schema.withDecodingDefaultTypeKey(
      Effect.sync(() => Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("1970-01-01T00:00:00.000Z"))
    )
  )
})
console.log(Schema.decodeUnknownSync(TypeSide)({}).at)

// 坑 3：每次解码都会重新执行这个 Effect
let n = 0
const Counter = Schema.Struct({
  k: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ++n)))
})
const decode = Schema.decodeUnknownSync(Counter)
console.log(decode({}), decode({}), decode({ k: 9 })) // { k: 1 } { k: 2 } { k: 9 }

// 坑 4：Key 版本只管「键缺失」，显式 undefined 会被拒绝
try {
  decode({ k: undefined })
} catch (e) {
  console.log(String(e)) // SchemaError(Expected number at ["k"])
}

// 编码时默认保留；encodingStrategy: "omit" 可以把键省掉
const Omit = Schema.Struct({
  k: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1), { encodingStrategy: "omit" })
  )
})
console.log(Schema.encodeSync(Omit)({ k: 1 }), Schema.encodeSync(Counter)({ k: 1 })) // {} { k: 1 }
```

把四个坑归成一条规则：**默认值是一个产出 Encoded 值的 Effect，发生在解码之前。**

- 它是 Effect，所以可以带副作用和服务依赖，也意味着每次解码都重新求值。想要「每次都是新的 id」用 `Effect.sync`，想要「永远是同一个常量」用 `Effect.succeed`。
- 它是 Encoded 类型，所以 `DateTimeUtcFromString` 的默认值写字符串，而不是 `DateTime`。想直接写 Type 一侧的值，换成 `withDecodingDefaultTypeKey`。
- Key 版本对应 `optionalKey`：键可以缺失，但不能是 `undefined`。上游如果会显式传 `undefined`，用 `withDecodingDefault`（先 `Schema.optional`），它覆盖「缺失或 undefined」两种情况。

这些错误里，类型层面能抓到的（thunk、写错一侧）编译期就会报，抓不到的是第三条的「每次求值」，它只会在运行时表现为行为差异，写默认值时要有意识。

## 什么时候用哪个

我自己的取舍是这样的：

- 对接第三方库：先问对方支不支持 Standard Schema，支持就 `toStandardSchemaV1`，不要自己写适配器。
- 存储、消息队列、跨服务：用 `toCodecJson` 定一个统一口径，别各处直接 `JSON.stringify`。
- 查询串、表单、环境变量：`toCodecStringTree`。
- 给前端、OpenAPI、工具调用参数用的契约文档：`toJsonSchemaDocument`，同时记得它只是预校验。
- 日志、测试、去重：`toFormatter` 与 `toEquivalence`。
- 变更记录、差量同步：`toDifferJsonPatch`，前提是 Schema 是纯同步的。

要不要全上，看你有没有「同一个形状被多处重复定义」的痛点。如果项目里只有一个解码入口，`decodeUnknownEffect` 就够了，不必为了工具链而工具链。

## 小结

Schema 的价值不止是边界解码。同一份定义可以派生 Standard Schema、JSON 与字符串编解码器、draft-2020-12 的 JSON Schema、Equivalence、Formatter 和 JSON Patch 差分器，它们共享同一个生成器，所以天然不会漂移。

派生出的 JSON Schema 描述的是 `toCodecJson` 的形态，只能做预校验。`withDecodingDefaultKey` 的默认值是产出 Encoded 值的 Effect，不是 thunk，也不是 Type 值，并且每次解码都会重新执行。下一篇会继续讲 Schema 里的判别联合，用它建模领域状态机。
