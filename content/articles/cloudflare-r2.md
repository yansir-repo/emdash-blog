---
title: "R2：对象存储、预签名上传、公开访问与缓存"
description: 讲清 R2 的强一致模型、Workers 绑定 API、大文件的预签名直传与分片上传，以及 r2.dev 与自定义域名的差别和缓存陷阱，最后给出什么时候该用、什么时候别用 R2 的取舍。
date: 2026-10-22
tags: [cloudflare, tutorial, storage]
category: cloudflare
chapter: 7
---

> 限额、价格与行为以 2026-10 官方文档为准，会变化。标注「来自官方文档，未实测」的内容没有在本地复现过；标注「本地实测」的内容在 wrangler dev（workerd）上跑过。本地模拟不能验证跨地区的一致性、缓存行为、计费与限流。

## 问题：文件放哪里

用户头像、文章附件、导出报表、备份，这些都是「一整块字节 + 一个名字」。放进数据库会撑爆行大小和备份；放进 KV 受 25 MiB 值上限和最终一致限制；放在应用服务器的磁盘上，横向扩展就会碎掉。这类数据需要的是对象存储：键是字符串，值是任意字节，整体读写，不支持原地修改。

朴素做法是用一家 S3 兼容服务，应用读写都经过自己的服务器中转。问题有两个：大文件流量白白经过你的计算层，以及出口流量费。R2 的定位正是针对这两点：它兼容 S3 API，并且官方文档写明，通过 Workers API、S3 API 或 r2.dev 从 R2 直接提供数据时，出口流量免费（来自官方文档，未实测）。需要注意的是，请求次数仍然计费，别的计费服务（比如叠加的其他产品）也可能有自己的费用。

## R2 的模型与保证

R2 的数据模型很简单：bucket 里是 object，object 由 key、body、`httpMetadata`（Content-Type、Cache-Control 等）和 `customMetadata`（字符串键值）组成。没有目录，所谓「文件夹」只是 key 里的前缀加 `delimiter`。

最值得记住的是一致性。官方文档的表述是：R2 对绝大多数操作是强一致的，写入成功后读到新对象，删除后立即读不到，list 反映当下状态；带条件的写入（如 `If-None-Match: *`）是对已提交状态原子判断的，并发时最多一个成功（来自官方文档，未实测；官方没有说明同一 key 普通并发覆盖写谁胜出，不要依赖）。这与 [KV](/articles/cloudflare-kv) 形成鲜明对比，也是两者选型的第一条分界线，更完整的对比见[存储选型](/articles/cloudflare-storage-decision-tree)。

文档列出了三个例外，都值得在设计时留意：

- 新建或更新 API 令牌的权限（IAM）是最终一致的，最长可能要一分钟才全球生效。
- 读不到（404）并不能证明之前的写入失败，那次写入可能仍在途中。要确认写入失败，请等它结束，或者用 `If-None-Match: *` 重试。
- 自定义域名**开启缓存**后不再强一致：被删除或覆盖的对象可能继续被缓存提供，404 也可能被缓存，直到 TTL 过期或手动 purge。Worker 绑定和 S3 API 绕过缓存，不受影响。

此外还有几条限额（以 2026-10 官方文档为准，会变化，写在方案里之前请再核对官方页面）：单个 object 最大约 5 TiB，单次（非分片）上传最大约 5 GiB，key 最长 1,024 字节，自定义元数据 8,192 字节，**同一个 key 的并发写入限制为每秒 1 次，超出会得到 429**（来自官方文档，未实测）。官方限额页对分片上传的单片上限自相矛盾（表格与脚注分别写 TiB 与 GiB 量级的数字），以官方为准。最后一条常被忽略：把 R2 当「高频更新的计数器文件」用会直接撞墙。本地模拟不执行这个限流：本地并发 5 次写同一个 key 全部成功，所以本地测试不能说明线上不会 429。

## Workers 绑定：最小例子

绑定在 wrangler.jsonc 里声明：

```jsonc
{
  "name": "files",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "my-bucket" }
  ]
}
```

读、写、条件请求都是同一套 API。下面这个 Worker 把 R2 对象作为 HTTP 资源提供，包含条件请求和 Range：

```ts
export default {
  async fetch(req: Request, env: { BUCKET: R2Bucket }): Promise<Response> {
    const key = new URL(req.url).pathname.slice(1);

    if (req.method === "PUT") {
      const obj = await env.BUCKET.put(key, req.body, {
        httpMetadata: { contentType: req.headers.get("content-type") ?? undefined },
      });
      return Response.json({ etag: obj?.httpEtag });
    }

    // 直接把请求头交给 R2，它会处理 If-None-Match / Range 等
    const obj = await env.BUCKET.get(key, {
      onlyIf: req.headers,
      range: req.headers,
    });
    if (obj === null) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);

    // 条件不满足时 get 返回没有 body 的 R2Object
    if (!("body" in obj) || obj.body === undefined) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(obj.body, { headers });
  },
};
```

本地实测的几个行为：`get` 在 key 不存在时返回 `null`；`onlyIf: { etagDoesNotMatch: etag }` 命中时返回的对象没有 `body`；`put` 带不满足的 `onlyIf` 时返回 `null` 且不写入；`range: { offset: 1, length: 3 }` 能读到对应字节；`list({ delimiter: "/" })` 会在 `delimitedPrefixes` 中给出「目录」。上面的 `onlyIf: req.headers` 和 `range: req.headers` 是官方文档支持的形式（除 `If-Range` 外的条件头均支持），这一写法本地也实测过：`onlyIf` 传 `If-None-Match` 头且 etag 匹配时返回的对象没有 `body`（对应 304），传 `Range: bytes=1-3` 头读到对应字节且 `range` 为 `{ offset: 1, length: 3 }`；`put` 的 `onlyIf: { etagDoesNotMatch: "*" }` 在 key 已存在时返回 `null`，不存在时写入。生产中仍请自行覆盖 304 与 206 的端到端测试。

`list` 的分页有个常见坑：循环条件是 `truncated`，而不是「返回条数是否等于 limit」，因为用了 `include` 之类选项后条数可能少于 limit。

## 大文件：预签名直传与分片

用户上传 200 MB 视频，让它先穿过你的 Worker 是浪费。常见做法是预签名 URL：服务端用 R2 的 S3 凭证签一个有时限的 URL，浏览器直接 PUT 到 R2。

官方文档对预签名的要点（来自官方文档，未实测）：

- 支持 GET、HEAD、PUT、DELETE，不支持 POST 表单上传。
- 有效期 1 秒到 7 天。
- 域名是 `<ACCOUNT_ID>.r2.cloudflarestorage.com`，**自定义域名不支持预签名**。
- 它是 bearer token：拿到 URL 的人在过期前都能执行被授权的操作。把 `ContentType` 纳入签名可以限制上传的类型。
- 浏览器跨域使用时必须给 bucket 配 CORS。过期的预签名 URL 返回的 403 不带 CORS 头，前端 JavaScript 读不到具体错误，所以要在过期前刷新。

用 AWS SDK v3 签发：

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const url = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket: "my-bucket", Key: key, ContentType: "image/png" }),
  { expiresIn: 600 },
);
```

`accessKeyId` 与 `secretAccessKey` 是 R2 API 令牌，应当作 secret 管理，不要写进代码或 wrangler.jsonc。

如果文件特别大，或要在 Worker 里断点续传，用分片：`createMultipartUpload` 得到 `uploadId`，每片 `uploadPart`，最后 `complete`。规则（来自官方文档）：最小片 5 MiB（最后一片除外），除最后一片外所有片大小必须相同，最多 10,000 片，未完成的分片上传默认 7 天后自动 abort，可以用生命周期策略修改。其中「片大小必须一致」与「非末片不小于 5 MiB」本地实测成立：5 MiB 加 6 MiB 加末片的组合在 `complete` 时被拒绝（错误码 10048），非末片只有 1 KiB 时被拒绝（10011）；10,000 片与 7 天清理未实测。

## 公开访问与缓存

让 bucket 对外可读有两种方式，差别很大（来自官方文档，未实测）：

- **r2.dev 子域名**：只适合开发测试，有速率限制，超出会 429；没有缓存，没有 WAF 自定义规则，没有 Access，也没有 Bot Management。
- **自定义域名**：可以走 Cloudflare Cache、WAF、Access。默认只缓存部分文件类型，要缓存全部需要 Cache Everything 规则。

如果你用了 WAF 或 Access 来保护 bucket，请务必关掉 r2.dev，否则 bucket 仍可通过该子域名公开读取，规则被整个绕过。

缓存要和上面的一致性例外连起来看：自定义域名开缓存，吞吐和延迟更好，代价是「覆盖写之后旧内容还会被提供一段时间」。建议使用**不可变 key**：文件名带内容哈希或版本号，永不覆盖，这样缓存不会陈旧，也规避了同 key 每秒 1 次写入的限制。必须覆盖同一个 key 时，要么写完主动 purge，要么让需要新鲜数据的路径走 Worker 绑定（它绕过缓存）。

## 取舍与常见误区

**什么时候用 R2**：用户上传、静态资源、备份、日志归档、AI 数据集等「整块读写、体积大、读多」的数据；出口流量成为主要成本的场景。

**什么时候别用**：

- 需要按字段查询、事务、关联：用 [D1](/articles/cloudflare-d1)，R2 里只放文件，D1 里放文件的元数据和权限。
- 高频更新同一个小对象（计数器、会话）：同 key 写入有每秒 1 次限制，应当用 Durable Objects。
- 极小的配置、读极多且能接受延迟传播：[KV](/articles/cloudflare-kv) 更合适。

**常见误区**：

1. 把 list 当数据库查询用。list 按 key 字典序，只有前缀过滤，复杂检索请自己维护索引。
2. 以为 r2.dev 能上生产。官方文档明确它只用于开发。
3. 只配了 WAF 却忘了关 r2.dev。
4. 预签名 URL 外泄不当回事。它就是密码，有效期要短，并限制 ContentType 或 key。
5. 不设分片清理策略。未完成的分片会占存储，默认 7 天后才清理。
6. 用原始文件名当 key，用户重复上传导致覆盖。key 应由服务端生成，原名放 `customMetadata`。

## 小结

R2 是强一致的、出口免费的对象存储，主要边界是：不是数据库，同 key 写入频率有限，公开访问要用自定义域名并理解缓存带来的陈旧。上传走预签名直传，key 设计成不可变，元数据放进 D1，这是大多数项目的稳妥组合。

## 延伸阅读

- [Cloudflare 存储怎么选](/articles/cloudflare-storage-decision-tree)
- [KV：最终一致的真实含义与缓存模式](/articles/cloudflare-kv)
- [D1：迁移、事务与批处理](/articles/cloudflare-d1)
- [R2 一致性模型（官方）](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 限制（官方）](https://developers.cloudflare.com/r2/platform/limits/)
- [预签名 URL（官方）](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 官方文档](https://developers.cloudflare.com/r2/)
