---
title: "Effect v4 的稳定性标注：@stability 标签取代 unstable 目录"
description: 说明 Effect 4.0.5 如何用 JSDoc 的 @stability 标签而非 effect/unstable 路径标注 API 稳定性，如何用语言服务诊断管理 unstable 用法，并附可复现的扫描脚本和 4.0.5 里仍是 unstable 的模块清单。
date: 2026-10-22
tags: [effect, effect-advanced, stability, language-service]
category: effect
---

写 Effect v4 时有一个容易被忽略、却会决定你升级成本的问题：你正在用的 API 稳不稳定。v4 beta 阶段的文档提到过 `effect/unstable/*` 这样的导入路径，到了 4.0.5，这条路径已经不存在了，稳定性改由每个导出上的 JSDoc 标签表达。

这篇回答四件事：标签是什么、为什么这样设计更好、怎么在项目里发现并管理 unstable 用法、4.0.5 里到底哪些常用模块还是 unstable。最后一件我用脚本实际统计过，脚本附在文中。

## 机制：@stability 标签

每个导出声明的 JSDoc 里都带 `@stability stable`、`@stability unstable` 或 `@stability experimental` 之一。我扫描 4.0.5 的 `dist/**/*.d.ts` 得到的总数是：stable 约 6.7 千处、unstable 约 5.4 千处、experimental 263 处（按标签出现次数统计，含重载与方法，所以大于声明数）。

含义如下（`unstable` 的含义来自迁移文档对 unstable 模块的描述，`experimental` 一项是我的理解）：

- `stable`：遵循 semver，小版本不会破坏。
- `unstable`：功能基本成型，但小版本里可能有破坏性变更。
- `experimental`：更早期，可能大改甚至移除。

我验证了一件事：4.0.5 的 `package.json` 的 `exports` 里没有任何包含 `unstable` 的子路径，`dist` 下也没有 `unstable` 目录。HTTP、RPC、SQL、AI 等模块现在直接在 `effect/http`、`effect/rpc`、`effect/sql`、`effect/ai` 下，但它们大多仍然是 unstable。**路径里没有 unstable，不等于它稳定**，这是这个设计带来的新陷阱。

### 为什么我觉得标签比目录好

目录把稳定性编码进了 import 路径，于是「晋升」必然是破坏性改动：每个用户都要改所有 import。标签把稳定性变成元数据，据此晋升只需要改标签，import 路径不变。这是我对设计意图的解读：4.0.5 里路径确实不带 unstable，但晋升流程本身要等具体模块晋升后才能观察，我没有验证。

代价同样明显：目录是编译期可见的硬边界，标签只是注释，默认没人提醒你。所以需要工具来补上这一环。

## 在项目里发现并管理 unstable 用法

下面这部分来自 Effect 语言服务的 tsgo 版本（`@effect/tsgo`）的 README 与相关 PR，**我没有在本地运行它**（它需要 TypeScript 7 的原生编译器）。另外我装了 npm 上的 `@effect/language-service@0.87.5`，在其 README、schema 与 `index.js` 里没有找到这些规则，所以别想当然地认为旧版语言服务插件有它们。

README 里的相关项：

- `unstableApiUsage`：使用了标注 `@stability unstable` 的 API 时警告。
- `experimentalApiUsage`：使用了标注 `@stability experimental` 的 API 时警告。
- `apiStabilityLeak`：面向库维护者，报告公开签名暴露了稳定性更低类型的导出。默认关闭。
- `allowedUnstableApis`、`allowedExperimentalApis`：放行名单，默认空数组。

放行名单的写法：模块路径（如 `effect/http`）放行该模块及其子模块；`模块#导出名` 只放行单个导出，大小写敏感且按路径段匹配，所以 `effect/http` 不会放行 `effect/http-api`。README 示例的配置形态是：

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": true,
        "allowedUnstableApis": ["effect/http", "effect/rpc/RpcClient#make"],
        "allowedExperimentalApis": []
      }
    ]
  }
}
```

我的用法建议（推论，未实测）：

1. 默认让两条规则保持警告，团队里每个 unstable 用法都会被看见。
2. 对决定接受风险的模块，在放行名单里显式写入，等于在 tsconfig 里留下一份「我们依赖的 unstable 清单」，升级前逐条检查 changelog。
3. 放行粒度尽量用 `模块#导出`，而不是整个模块，避免顺手放行更多 API。
4. 发布库时打开 `apiStabilityLeak`：你的公开类型里如果出现了 unstable 类型，你的使用者就间接依赖了它，你的 semver 承诺也就悬空了。

已知问题：tsgo 仓库里有一个 issue（#833）报告同时开启这两条规则时可能出现多余的 TS2488、TS2698 错误。我没有复现，升级前请先查它的状态。

没有语言服务时，也可以用下面的 bash 先粗略盘点你实际 import 了哪些子路径，再对照后面的清单：

```bash
grep -rhoE 'from "effect/[^"]+"' src | sort | uniq -c | sort -rn
```

## 可复现的扫描脚本

脚本遍历 `node_modules/effect/dist` 下的 `.d.ts`，取每个导出声明前紧邻的 JSDoc 里的 `@stability`，按声明名去重后分类：整个模块都是同一标签就归为该标签，否则是 mixed。在装有 `effect@4.0.5` 的项目根目录执行 `npx tsx scan.ts`：

```ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

type Tag = "stable" | "unstable" | "experimental"
const tags: ReadonlyArray<Tag> = ["stable", "unstable", "experimental"]

const dist = join(process.cwd(), "node_modules/effect/dist")

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === "internal") return []
    if (statSync(path).isDirectory()) return walk(path)
    return name.endsWith(".d.ts") && name !== "index.d.ts" ? [path] : []
  })

// 每个导出声明前紧邻的 JSDoc 里的 @stability 标签，按声明名去重
const declRe =
  /\/\*\*((?:(?!\*\/)[^])*)\*\/\s*\n\s*export (?:declare )?(?:const|function|interface|class|type|namespace) (\w+)/g

interface Row {
  readonly module: string
  readonly counts: Record<Tag, number>
  readonly nonStable: ReadonlyArray<string>
}

const rows: Array<Row> = walk(dist).sort().map((file) => {
  const src = readFileSync(file, "utf8")
  const bySymbol = new Map<string, Tag>()
  for (const m of src.matchAll(declRe)) {
    const tag = /@stability (\w+)/.exec(m[1] ?? "")?.[1]
    if (tag !== undefined && (tags as ReadonlyArray<string>).includes(tag)) {
      bySymbol.set(m[2] ?? "", tag as Tag)
    }
  }
  const counts: Record<Tag, number> = { stable: 0, unstable: 0, experimental: 0 }
  for (const tag of bySymbol.values()) counts[tag]++
  return {
    module: "effect/" + relative(dist, file).replace(/\.d\.ts$/, "").replace(/^(.*)\/\1$/, "$1"),
    counts,
    nonStable: [...bySymbol].filter(([, t]) => t !== "stable").map(([name]) => name)
  }
})

const classify = ({ counts: c }: Row): string => {
  const total = c.stable + c.unstable + c.experimental
  if (total === 0) return "untagged"
  for (const tag of tags) if (c[tag] === total) return tag
  return "mixed"
}

const groups = new Map<string, Array<Row>>()
for (const row of rows) {
  const key = classify(row)
  groups.set(key, [...(groups.get(key) ?? []), row])
}

for (const [kind, list] of groups) console.log(`${kind}: ${list.length} modules`)

const bucket = (rowsIn: ReadonlyArray<Row>) => {
  const out = new Map<string, number>()
  for (const r of rowsIn) {
    const parts = r.module.split("/")
    const key = parts.length > 2 ? `effect/${parts[1]}` : r.module
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return [...out].map(([k, n]) => (k.split("/").length === 2 && n > 1 ? `${k}/* (${n})` : k))
}

console.log("\nunstable:", bucket(groups.get("unstable") ?? []).join(", "))
console.log("\nmixed (module: non-stable declarations):")
for (const r of groups.get("mixed") ?? []) {
  const names = r.nonStable.slice(0, 6).join(", ")
  console.log(`  ${r.module}: ${r.nonStable.length} (${names}${r.nonStable.length > 6 ? ", ..." : ""})`)
}
```

## 4.0.5 的实际结果

我在 `effect@4.0.5` 上运行得到：

```text
unstable: 230 modules
stable: 113 modules
mixed: 12 modules
untagged: 3 modules
experimental: 11 modules
```

整个模块都是 unstable 的，按目录归并后是：

```text
effect/ai/* (20), effect/cli/* (12), effect/cluster/* (39), effect/devtools/* (4),
effect/encoding/* (6), effect/eventlog/* (14), effect/http-api/* (13), effect/http/* (32),
effect/net/* (2), effect/observability/* (8), effect/persistence/* (7), effect/process/* (2),
effect/reactivity/* (8), effect/rpc/* (12), effect/schema/* (6), effect/socket/* (2),
effect/sql/* (9), effect/testing/* (3), effect/workers/* (4), effect/workflow/* (8)
单文件：Arbitrary, ByteSize, ChannelSchema, Crypto, ErrorReporter, ExecutionPlan, FileSystem,
Graph, HashRing, LayerMap, LayerRef, Newtype, PartitionedSemaphore, Path, PlatformError,
Stdio, Terminal, TxChunk, Version
```

几个对日常开发最有影响的事实：

- `FileSystem`、`Path`、`Terminal`、`Stdio` 这些平台抽象是 unstable。
- HTTP 客户端与服务端（`effect/http`）、`effect/http-api`、`effect/rpc`、`effect/sql`、`effect/ai`、`effect/workflow`、`effect/cluster`、`effect/cli`、前端用的 `effect/reactivity`（Atom）、`effect/observability` 的 OTLP 导出，全部是 unstable。本系列前面[HTTP](/articles/effect-http)、[SQL 与 RPC](/articles/effect-sql-and-rpc)、[可观测性](/articles/effect-observability)等篇讲的就是这些模块，请带着这个前提读。
- 核心的 `Effect`、`Layer`、`Context`、`Stream`、`Schema`、`Schedule`、`Cache`、`Queue`、`PubSub`、`Pool`、`RcMap`、`Resource`、`ManagedRuntime` 是 stable；`LayerMap`、`LayerRef` 例外，它们是 unstable。

mixed 模块是「整体 stable、个别声明不是」，脚本给出的清单：

```text
effect/Config: 1 (ByteSize)
effect/ConfigProvider: 2 (fromDotEnv, fromDir)
effect/Effect: 2 (withExecutionPlan, withErrorReporting)
effect/Logger: 1 (toFile)
effect/RequestResolver: 1 (persisted)
effect/Schema: 90 (ByteSize, MacAddress, ... 一批网络与字节大小相关的 Schema)
effect/Stream: 2 (withExecutionPlan, limitBytes)
effect/TxQueue: 34   effect/TxPubSub: 3   effect/TxSubscriptionRef: 1 (changes)
effect/net/NetAddress: 128（绝大多数 unstable）
```

另有 11 个 experimental 模块，主要是 `effect/graphql/*` 以及 `net/AddressResolver`、`net/Dns`、`net/Host`、`socket/DatagramSocket`。

注意脚本按声明统计，不看 re-export；模块内同一名字的多个重载若标签不同，以最后一次出现为准，这是脚本的简化。

## 小结

v4 用 `@stability` 标签代替 `effect/unstable/*` 路径：晋升不必改 import，但稳定性也不再体现在路径里，需要靠工具和习惯去看。4.0.5 里，核心运行时是 stable，而 HTTP、SQL、RPC、AI、Workflow、Cluster、CLI、Atom、平台抽象与 OTLP 仍是 unstable。我的做法是：用扫描脚本盘点自己的依赖，用语言服务的警告加放行名单把 unstable 用法收成一份显式清单，库作者再打开 `apiStabilityLeak`。语言服务部分我没有本地运行过，以上配置请以官方 README 为准。
