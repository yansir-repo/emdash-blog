---
title: 未激活的插件会降低WordPress速度吗？
description: 很多建站小白听前辈说，WordPress的插件会影响网站速度，就会插件产生抗拒心理，觉得用不到的插件都一定要删掉，不然就会影响网站速度，但真的会影响吗？
date: 2020-07-28
author: 颜sir
category: marketing
redirectFrom: /deactivated-plugin-speed
tags: [wordpress]
---

很多建站小白听前辈说，WordPress的插件会影响网站速度，就会插件产生抗拒心理，觉得用不到的插件都一定要删掉，不然就会影响网站速度，但真的会影响吗？

**答案是：不会。插件在未激活状态下，WordPress是不会调用插件的任何资源的，所以后台没有激活的插件，完全不会影响网站速度，只有激活了的插件才会影响网站速度，所以我们暂时用不到的插件，也不必删除。**

这篇文章会从以下几个方面，继续和你聊下WordPress插件的话题：

## 怎么知道哪些插件影响网站速度？

要想知道哪些插件影响了网站加载速度，最简单的方法就是用测速工具查一下，看哪些插件在首页加载了影响网站速度的资源。

测试网站速度，最好的两个测速工具分别是：

1. [GTMetrix](https://gtmetrix.com/)
2. [Google Page Speed Insight](https://developers.google.com/speed/pagespeed/insights/)
3. [Pingdom](https://www.pingdom.com/)

这里以GTMetrix为例，我尝试测了下我手上一个没做过任何速度优化的网站，结果如下：

![image-1024x580](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-189-1024x580.png/public)

因为安装了过多的插件，这个网站的打开速度惨不忍睹，接近8秒。

在上图红框框出来的位置，点开waterfall，在下方的搜索栏输入“plugin”，就可以把所有加载了资源的插件全筛出来，所有插件的名字都可以在链接中识别出来，比如我上图的链接是：

```
https://yansirwebsite.com/wp-content/plugins/gtranslate/gtranslate-style24.css?ver=5.4.2
```

看不懂完全没有关系，你只要看到，在这行链接的plugins后面会携带插件的名字，比如以上面这条链接为例就是gtranslate，那这条资源就是Gtranslate加载出来的。

我们用GTMetrix这种方式就能看个大概，做到心中有数，把所有罪魁祸首都先找出来。

特别是加载时间特别长的插件，一定要留意，比如在下面的截图中你能看到，我这个样站上，有个资源的加载时间将近3秒，而这个插件（WooCommerce Product Table Pro）我仅仅只用在了产品页上，从来没在首页用过，这就很有问题。

![image-1024x397](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-190-1024x397.png/public)

总之通过这种最简单的方法，我们就能迅速判断哪些插件拖慢了网站速度，从而直接禁用或者换一个速度更快的插件。

## 怎么消除插件对网站速度的影响？

如果我们通过上面的步骤查到，某个插件对网站速度有致命影响，但这个插件我们又不得不用，也不太容易找到速度快的替代品，那怎么办？

最便捷的方法就是下载一个“[Assets CleanUp](https://wordpress.org/plugins/wp-asset-clean-up/)”，这个插件本身是免费的，它可以把页面不需要用的资源都“屏蔽”掉，这样就不会在页面上加载不相干的资源。

后来实在觉得好用，我就买了它的付费版，使用了一段时间觉得和免费版没太大区别，故不做推荐。

这里大概介绍下使用方法，首先在WordPress的后台插件栏搜索并安装Assets CleanUp：

![image-1024x500](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-191-1024x500.png/public)

然后进入侧边栏中的Assets CleanUp → Settings → Stripping the “fat” → 点击下面的开启按键同意条款 → Update All Settings。

![image-1024x533](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-192-1024x533.png/public)

然后进入WordPress的首页的后台设置：

![image-1024x689](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-194-1024x689.png/public)

在页面底下就可以找到 Asset CleanUp: CSS & JavaScript Manager，并且就在附近可以看到“From Plugins”：

![image-1024x576](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-196-1024x576.png/public)

在这边可以找到首页加载的所有插件，所有你判断在首页用不到的插件，就可以点击插件右边的“Check All”，把这个插件（以WooCommerce Product Table PRO为例）所有资源全屏蔽掉。

![image-1024x631](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-197-1024x631.png/public)

这时再去GTMetrix测试网站速度，就能发现此时网站首页已不再加载WooCommerce Product Table PRO的任何资源：

![image-1024x569](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/deactivated-plugin-speed/deactivated-plugin-speed-image-198-1024x569.png/public)

网站速度也从之前的8秒变到了6秒，当然6秒的打开速度也还是太慢了，最好能让打开速度在4秒左右，当然这就是另一个话题，这里不展开。
