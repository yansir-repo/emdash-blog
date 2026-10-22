---
title: "配置与密钥：Config、Redacted 与环境差异"
description: "Effect 教程第 11 章：为什么不该直接读 process.env。讲 Config 是描述、Layer 构造时 fail-fast、withDefault 的边界、Redacted 防泄漏与 ConfigProvider 切换环境。"
date: 2026-10-10
tags: [effect, tutorial, config, redacted, secrets]
category: effect
series: effect-tutorial
seriesOrder: 11
---

配置是依赖图里最不起眼的一类叶子节点：端口、数据库地址、第三方 API 密钥。它不复杂，却是线上故障里「这个值到底是怎么变成这样的」的常客。这一章的目标是把配置也纳入前两章的框架：声明依赖、集中构建、类型可见。

## 要解决的问题

配置读取最常见的写法是散落在各处：

```ts
const port = Number(process.env.PORT ?? 3000)
const key = process.env.API_KEY!
```

这里藏着一串问题：

- `process.env.X` 的类型是 `string | undefined`，`!` 和 `??` 都是在「假装它存在」。
- `Number("abc")` 是 `NaN`，不会报错，会在很后面以奇怪的形态出现。
- 读取发生在使用的那一刻，缺了一个必填项，要等到某条代码路径第一次执行才暴露。
- 密钥是一个普通字符串，一旦被 `console.log(config)` 或错误对象带进日志，就永久留在日志系统里了。
- 测试想换一组配置，要改全局环境变量，并且要记得还原。

## 朴素做法为什么不够

常见的补救是写一个 `loadConfig()`，启动时校验并返回一个对象。这已经比散落读取好得多，但仍然有两处缺口：它是一个**立即执行的函数**，不能和其他依赖一起被装配与替换；它返回的密钥依然是裸字符串，泄漏防护全靠自觉。

## Effect 的做法

### Config 是对配置的描述

`Config<T>` 和 `Effect` 一样是**描述**：`Config.Int("PORT")` 不读取任何东西，只是说「我想要一个名为 PORT 的整数」。描述可以组合：

```ts
import { Config } from "effect"

const AppConfig = Config.all({
  port: Config.Int("PORT").pipe(Config.withDefault(3000)),
  apiKey: Config.Redacted("API_KEY"),
  logLevel: Config.Literals(["debug", "info", "warn"], "LOG_LEVEL").pipe(
    Config.withDefault("info" as const)
  ),
  db: Config.all({ url: Config.String("URL") }).pipe(Config.nested("DB"))
})
```

类型信息是完整的：`port` 是 `number`，`logLevel` 是字面量联合，`apiKey` 是 `Redacted<string>`（稍后讲）。`Config.nested("DB")` 给内部所有键加上前缀，所以这里的 URL 实际读的是 `DB_URL`。

`Config` 可以直接在 `Effect.gen` 里 `yield*`，失败类型是 `ConfigError`。也就是说它天然是 Effect 世界里的一员，读取失败是一个有类型的失败。

### 在 Layer 构造时读取，fail-fast

把配置当成服务提供，是上一章 Layer 的直接应用：

```ts
import { Config, Context, Effect, Layer } from "effect"

class Settings extends Context.Service<Settings, Config.Success<typeof AppConfig>>()("app/Settings") {
  static readonly layer = Layer.effect(Settings, AppConfig)
}
```

`Settings.layer` 构建的时候读取配置。这带来两个好处。第一，缺必填项、格式错误会让 **Layer 构造失败**，程序在启动阶段就停下，而不是在某个请求里才炸。第二，业务代码只依赖 `Settings`，从不接触环境变量：它拿到的是已经校验过、类型明确的值。

配置来源与读取逻辑被收拢成一处，其余代码对「值来自环境变量、文件还是别的地方」一无所知。

### withDefault 的边界

`Config.withDefault(3000)` 只在**键缺失**时用默认值；键存在但格式错（比如 `PORT=abc`）依然是失败，不会被默认值悄悄吞掉。这是个对的设计，因为「写错了」和「没写」是两件事。

但默认值本身是个需要克制的东西：

- 对**行为参数**（端口、日志级别、超时）给默认值是合理的。
- 对**密钥与连接串**不要给默认值。缺了就应该启动失败，而不是带着一个开发环境的占位值悄悄跑在生产上。

判断标准是：「缺了这个值，程序继续运行是否安全」。不安全，就不给默认值。

### Redacted：让密钥不可能被顺手打印

`Config.Redacted("API_KEY")` 读出来的不是字符串，而是 `Redacted<string>`。它包裹的值在被打印、被字符串化、被 JSON 序列化时，都显示为 `<redacted>`（`console.log`、模板字符串和 `JSON.stringify` 三种情形都已实测）：

```ts
import { Redacted } from "effect"

const key = Redacted.make("sk-secret")
console.log(key)                   // <redacted>
console.log(`${key}`)              // <redacted>
console.log(JSON.stringify({ key })) // {"key":"<redacted>"}
Redacted.value(key)                // "sk-secret"，只在真正要用的地方取出
```

它的意义是把「不泄漏」从「每个人都记得别打印」变成「类型上就拿不到明文」：要取明文，必须显式调用 `Redacted.value`，代码评审时这一行很显眼。使用原则是只在调用边界解开，比如设置 HTTP 头的那一行，解开后的明文不要再赋给变量往下传。

要说清楚它**不是什么**：`Redacted` 不是加密，内存里仍然是明文，它防的是「顺手泄漏」，不是恶意读取。

### 环境差异：换提供者，不改业务

开发、测试、生产的差别，本质是「配置从哪读」的差别。`Config` 从当前的 `ConfigProvider` 读取，默认的提供者读环境变量；你可以替换它：

```ts
import { ConfigProvider } from "effect"

const fakeEnv = ConfigProvider.fromEnvRecord({
  API_KEY: "test-key",
  DB_URL: "pg://localhost/test"
})

const testLayer = Settings.layer.pipe(
  Layer.provide(ConfigProvider.layer(fakeEnv))
)
```

测试里不需要改全局环境变量，也不会污染其他测试；提供者就是一个普通值，和任何其他 Layer 一样可以替换。第 12 章会把这个用法放进测试里。

另一种做法是在测试里完全绕过 `Config`，直接 `Layer.succeed(Settings, { ... })` 提供一个写死的配置。两种都可以：前者连「配置读取逻辑本身」一起测，后者更轻。

## 常见误区

- **在业务函数里直接 `yield* Config.String("X")`**。技术上可行，但这等于把环境读取散落回各处，启动时无法一次性发现缺项，测试也要拨提供者。配置的读取集中在 Layer 构造里，业务只依赖结果服务。
- **给密钥设默认值**。上面说过，缺密钥应该是启动失败。
- **以为 Redacted 能防一切**。它只防日志、序列化这类顺手泄漏；解开之后的明文该怎么保护，仍是你的责任。
- **把 `withDefault` 当成容错**。它只处理「缺失」，不处理「非法」；非法值就是要让它失败。
- **把整个配置对象整体打日志来「方便排查」**。有了 `Redacted` 这样做是安全的，但仍建议只打必要字段，并且只在启动时打一次。
- **所有配置塞进一个巨大的 Settings**。按使用方拆分（数据库配置、HTTP 配置）更好：依赖的粒度小，测试替换也轻。

## 小结

- `Config` 是对配置的描述，可组合、类型完整、可 `yield*`。
- 在 Layer 构造时读取，缺项与格式错在启动时就失败；业务代码只依赖已校验的服务。
- `withDefault` 只管缺失；密钥不给默认值，并用 `Redacted` 防止顺手泄漏。
- 环境差异靠替换 `ConfigProvider`，不改业务代码。

依赖、Layer、配置到此齐备。能把依赖随意替换，最大的回报就在测试：下一章讲 [测试：替身 Layer、可控的时间](/articles/effect-tutorial-12-testing)。

## 延伸阅读

- [Effect 服务与 Layer：把依赖写进类型里](/articles/effect-services-and-layers)
- [Context.Reference：带默认值的服务，取代 FiberRef](/articles/effect-context-reference)
- [Effect v4 的稳定性标注：@stability 标签取代 unstable 目录](/articles/effect-stability-tags)
