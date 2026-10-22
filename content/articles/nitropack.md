---
title: 技术小白怎么给WordPress网站加速？
description: 很多不懂技术的朋友想优化网站速度，其实挺头疼的，因为它的过程非常繁琐，繁琐到连懂技术的我，一想到要优化网站速度，心情就和上坟一样。
date: 2022-09-05
author: 颜sir
category: marketing
redirectFrom: /nitropack
tags: [wordpress, tools]
---

很多不懂技术的朋友想优化网站速度，其实挺头疼的，因为它的过程非常繁琐，繁琐到连懂技术的我，一想到要优化网站速度，心情就和上坟一样。

真的，太繁琐了，中间的细节太多，你最好能知道从浏览器输入网址，一直到网页呈现内容的全过程，还要知道一些基础的css和javascript知识，更别提还有复杂的CDN在等着你……

是不是上面那句话就看不懂了？看不懂就对了，最开始接触WordPress速度优化的人，绝对都是懵的。

**那技术小白到底怎么给WordPress网站加速？方法很简单，在WordPress网站后台，安装一个[“Nitropack”](https://nitropack.io/#KCEYBP)的插件即可，整个过程不到3分钟，全程不用接触任何代码，就会获得非常好的速度，在任何测速平台，都能得到不错的分数。**

特别是最严厉的谷歌移动端测速[Google Speed Insight](https://developers.google.com/speed/pagespeed/insights/?url=http%3A%2F%2Fxunpanziyou.com%2F)，用Nitropack都能拿到很好的评分，比如询盘自由网，就是我用WordPress搭出来的：

![image-1024x581](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-1024x581.png/public)

如果你的网站装上Nitropack，最终测出来的分数，应该会在80分\~100分之间。

你可能会问，颜sir，你怎么没拿到100分？

首先，在[Google Speed Insight](https://developers.google.com/speed/pagespeed/insights/?url=http%3A%2F%2Fxunpanziyou.com%2F)要拿到好分数非常困难，不信你可以把你网站放进去，大多数都会惨不忍睹，就连SEO圈子的顶级大佬，Brain的博客[Backlino](https://backlinko.com/)，分数也才80分不到：

![image-1024x569](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-1-1024x569.png/public)

Brain的团队没钱做优化吗？没技术员做优化吗？并不是，而是这项测试本身就很难拿高分，它非常严格。

但用了Nitropack，即便你是技术纯小白，也可以轻松拿到非常高的分数。

明白了Nitropack到底有多牛批之后，接下来我会从以下几方面展开这篇文章：

## 怎么注册Nitropack？

注册Nitropack可以点询盘自由网首页的链接或[这个链接](https://nitropack.io/#KCEYBP)，以后如果付费会有价格优惠（结算时填入折扣代码“IMIKER10OFF”），虽然小网站用Nitropack就够了，但保不齐哪天会用到：

![image-1024x381](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-18-1024x381.png/public)

进入官网后，注册的流程我就不展开了，无非是填入用户名、邮箱、验证信息那一套。

这里有个小细节：Nitro的官网首页，有个能输入网址的地方，你不妨把你网站输入进入，看看Nitro能帮你网站做到的极限。

![image-1024x525](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-2-1024x525.png/public)

这里以我朋友一个网站做下小白鼠：

![image-1024x560](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-3-1024x560.png/public)

不测不知道，我这个朋友的网站居然这么垃圾……亏他网站还是月PV几万的大站，结果测出来，Google Insight桌面端的分数才28，移动端12，但如果安装了Nitropack，却可以优化到两个90+。

特别是移动端的打开速度，可以从之前的23.97s，优化到1.27s！鹅妹子嘤！

经过我实践，Nitropack的首页测试，并不一定每次都能实现承诺，有略微夸大的成分，但非常接近，不属于吹牛。

## 怎么使用Nitropack？

注册好账号之后，右上角会有个“New Website”的按键：

![image-1024x665](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-4-1024x665.png/public)

如果不是这个界面，那肯定是Nitropack改版，但总逃不出，让你输入网站地址，获取秘钥的操作，所以我的教程作为参考，实际配置时，灵活变通。

点击之后，填入网站名，命个名字，选择免费套餐，然后选择继续：

![image-1024x854](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-5-1024x854.png/public)

补充一句，我这里填入的网址，是一个测试站，在没有用Nitropack之前，他的谷歌移动端分数是这样的，等下让Nitropack上演奇迹：

![image-1024x554](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-6-1024x554.png/public)

再接下来会进到下面这个界面，点击左侧“Connect Your Website”：

![image-1024x452](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-7-1024x452.png/public)

下面的“Site ID”和“Site Secret”复制到记事本中，等下有用：

![image-1024x438](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-8-1024x438.png/public)

## 绑定WordPress网站前的准备工作

登录WordPress网站后台，先把能优化网站速度的插件，通通禁用，常用的加速插件包括：

- SG Optimizer
- Litespeed
- Jetpack
- Asset CleanUp
- WP Optimize
- WP Rocket
- Autoptimize
- W3 Total Cache
- WP Fastest Cache
- Cloudflare

注意：如果你的网站有以上任何一个插件，或我没有提到的速度优化插件，最后都会导致Nitropack优化失败！

如果你不了解你网站后台每个插件的具体用处，那就谷歌搜索，了解下大概的用处，但凡提到了“speed”这样的关键词，都统统禁用。

特别是Cloudflare，如果启用了，一定要关闭，如果不想关闭，请务必保证阅读了这个[官方文档](https://help.nitropack.io/en/articles/3558199-nitropack-and-cloudflare)，确保兼容不会出现问题后谨慎配置。

如果插件仅仅只做图片优化，那是可以和Nitropack一起用的，比如你的网站安装了shortpixel，我实践过了，没问题。

## 怎么绑定Nitropack和WordPress？

在插件市场搜索“Nitropack”，注意开发者名字是“NitroPack LLC”，别下载错了：

![image-1024x712](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-9-1024x712.png/public)

安装并激活后之后，在插件列表中选择“settings”：

![image-1024x657](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-10-1024x657.png/public)

进入到这个界面，点击“Connect to NitroPack”下方的“Enter details manually”，之所以不点上面的按键，是为了防止链接不上官网：

![image-1024x727](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-12-1024x727.png/public)

之后，输入之前的“Site ID”和“Site Secret”，点击“Connect to NitroPack”，就大功告成了：

![image-1024x675](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-13-1024x675.png/public)

连接成功后，网站左上角导航条会有小绿点提示，同时，界面红色框框区域，还会告诉你当前有几个页面正在优化：

![image-1024x529](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-14-1024x529.png/public)

等这里的“0”变成了其他数字，就可以去Google Insight做测试了，测试之后的结果相当震撼：

![image-1024x474](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-15-1024x474.png/public)

## 使用Nitropack的注意事项

我用Nitropack差不多半年了，踩了几个坑，你参考下，别也踩进去。

### 不要开启cache warmup

![image-1024x441](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-16-1024x441.png/public)

这个选项很诱人，我之前启用过，但启用的时候，我时不时会修改网站，这就导致Nitropack在后台给我抓出**几万个**无效链接，几万个！

后来我找官方的人问，他们也说不出个所以然，摸索了好几天才发现是这个选项的问题，气抖冷！

所以没事不要手贱开这个选项，特别你的网站时不时会微调，更不能启用。

### 优化等级调太高小概率对网站有影响

![image-1024x715](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-17-1024x715.png/public)

默认状态下，Nitropack会启用“Strong”等级的优化，但如果你想要极致的打开速度，启用了“Ludicrous”，那就要亲自把网站里里外外都看一看，点一点。

因为“Ludicrous”等级的优化，有小概率会让网站出现“闪屏”、“样式错位”的情况，所以，一旦发生样式问题，就退回到“Strong”。

### 不要再做更进一步优化

Nitropack类似于SaaS，所有的服务都在他们服务器，我们再想进一步DIY的可能性近乎没有，以前对某些优化细节不满意总想继续折腾，最终都证明，压根没有折腾的必要，躺平不动就是最好的优化。

所以Nitropack真的是技术小白的福音。

### 调整网站后要立即清理缓存

页面做了任何改动， 都要点击下面这个按键清理缓存，否则你的页面在客户浏览时，就还是老样子：

![image-1024x546](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-21-1024x546.png/public)

### 手动访问各个页面加快抓取

Nitropack在默认情况下，只会抓你首页的桌面端和移动端，你其他页面，Nitropack是不会帮你自动抓取的。

除非有客户访问你的页面唤醒了Nitropack，不然它是不会抓页面的，这样也节省了许多资源。

在这个规则下，第一次打开页面的客户，速度必然很差，因为那个页面还没经过Nitropack的优化，只有第二次打开页面的客户，才会感觉速度很快。

所以如果你希望第一次打开网站的用户，也能体验到超高的打开速度，就自己一个一个把网站的各个页面打开。

注意，只需要用桌面端打开一个页面，就会唤醒Nitropack自动抓取它的移动端，所以不需要再用手机也挨个点一遍。

## 总结

Nitropack不知道还能免费多久，我发现我不管推个什么工具，这个工具在外贸界就一定会火，火了之后就开始各种收费各种作妖。

但即使Nitropack以后取消免费版，只保留收费版，不知道你会不会买单，但我肯定会，因为真的太给力了。

现在询盘自由网用就是Nitropack的付费版，我很满意，除非出现更给力的工具，否则我会一直用到这个博客倒闭。

![image-1024x574](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/nitropack/nitropack-image-19-1024x574.png/public)
