---
title: 5分钟“榨干”任意关键词下的所有网址
description: 做SEO需要批量分析竞争对手的网站，做外贸也要根据某个关键词批量找网址，我来分享一个方法，让你能迅速爬取谷歌搜索结果页上的所有网址。
date: 2022-07-18
author: 颜sir
category: marketing
redirectFrom: /crawler-urls
tags: [seo]
---

做SEO需要批量分析竞争对手的网站，做外贸也要根据某个关键词批量找网址，我来分享一个方法，让你能迅速爬取谷歌搜索结果页上的所有网址。

先分享思路：

1. **将谷歌调为一页100条搜索结果；**
2. **制作“过滤器”；**
3. **使用谷歌插件+过滤器批量获取网址；**
4. **在Excel中去重；**

得到网址之后，不管是用hunter批量获取网站的地址，又或者是用ahrefs批量分析网站流量找到合适的站长，就随你了。

重要的是，我们用以上四步节约了大量时间，以下正文：

## 将谷歌调为一页100条搜索结果

第一步是将谷歌调为一页100条搜索结果，非常简单，如图所示，点开谷歌搜索页，右下角选中“设置→搜索设置”。

![image-1024x700](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-41-1024x700.png/public)

然后在设置页面中，将每页的搜索数调为“100”。

![image-1024x578](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-42-1024x578.png/public)

文章写到这里，我在想既然谷歌能直接展示100个页面，那有没有办法让谷歌呈现1,000个页面或者10,000个页面？

我用“can google display more than 100 result per page?”作为关键词查了下，翻了几个帖子发现都没提到怎么突破100上限，估计谷歌的查询最多只能返还100个结果吧。

暂时不管这个问题，如果你知道怎么一次性获取超过100个结果页，请私信我，送你个小礼物（我猜应该有，只要拼接下查询结果就行……用Python很容易实现，不过这个教程是写给小白的，就不dive too deep了）。

## 制作“过滤器”

再然后输入你想查的关键词，比如WordPress Theme，在谷歌浏览器上右键任意搜索结果，然后点击“检查”（没错，我们要看它的源代码）：

![image-1024x549](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-43-1024x549.png/public)

然后在最下面会出现一个源代码的框，观察一下，当把鼠标放到对应的代码块上时，这个代码块代表的文本会在浏览器上高亮出来：

![image-1024x554](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-44-1024x554.png/public)

我们要的是网址，所以上下翻找下，特别是三角形的下拉小箭头，也可以展开收起，一个个遍历，最终我们会找到一串代表着网址的代码块（哪怕你不熟悉代码，用最最笨的方法，5分钟也肯定能找到的）：

![image-1024x612](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-45-1024x612.png/public)

然后右键这串代码，选择“copy→copy xpath”：

![image-1024x563](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-46-1024x563.png/public)

此时你会得到类似于以下代码的东西（不要惊慌，不需要理解，照做就行）：

```
//*[@id="rso"]/div[1]/div/div[1]/a/div/cite/text()
```

这串代码其实就是个过滤器，待会儿我们会用谷歌插件批量抓取搜索结果页的源代码，如果有这个过滤器去过滤，最后我们就会得到一个网址，在我们的案例中，就是wordpress.org。

但我们想要的是一次性过滤出100个网址，所以我们要改造下这个过滤器，把里面所有的数字以及对应的中括号全删掉，就得到以下过滤器：

```
//*[@id="rso"]/div/div/div/a/div/cite/text()
```

这个过滤器就是个没什么特征的过滤器，能一次性匹配所有符合条件的结果，而不是仅匹配一个结果。

## 使用谷歌插件+过滤器批量获取网址

点击[这个链接](https://chrome.google.com/webstore/detail/mbigbapnjcgaffohmbkdlecaccepngjd)可以下载到我们需要的插件“Scraper”，下载好之后，在搜索结果页上右键点击页面空白处，会看到菜单栏出现一个“scrape similiar”。

![image-1024x515](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-47-1024x515.png/public)

点击后会自动进入到如下界面，也就说明我们把网页上的源代码成功抓取过来了：

![image-1024x575](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-48-1024x575.png/public)

在左上角填入我们上一步准备好的过滤器后，点击左下角的“scrape”，最后点击右下角的“copy to clipboard”，就能把所有抓取到网址复制到粘贴板了。

![image-1024x574](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-49-1024x574.png/public)

注意，这些网址有很大可能性有重复，比如搜索B2B的词，alibaba.com和amazon.com很有可能重复几十次，这时候就要用到Excel的去重功能。

## 在Excel中去重

打开Excel，将我们上一步得到的结果粘贴进来：

![image-1024x638](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-50-1024x638.png/public)

为了一次性把全部搜索结果都拿到手，我们可以把重复第四步，把所有搜索页的网址都收集到一起：

![image-1024x531](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-51-1024x531.png/public)

谷歌会把他认为重复度很高的页面隐藏起来，为了没有漏网之鱼，我们可以进入最后一页，在最后一页有“重新搜索以显示省略的结果”这一选项。

![image-1024x563](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-52-1024x563.png/public)

点击之后会出现更多页面，在我这个例子里，“WordPress theme”有将近500个页面，够我们分析的：

![image-1024x547](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-53-1024x547.png/public)

抓取完所有的网址之后，我们会得到一个很超长的Excel列表，选中所有的数据，点击Excel的“表格→删除重复项”：

![image-1024x592](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-54-1024x592.png/public)

然后就会可以得到一串干净的网址了：

![image-1024x539](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-55-1024x539.png/public)

## 拿到数据后怎么处理？

我平常做营销工作，需要和很多站长保持沟通，但也并不是每个网站都值得我花时间做调研以及和背后的站长social的，所以我一般会复制到付费的SEO工具ahrefs里，批量分析这些网站的关键词和流量。

![image-1024x489](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-56-1024x489.png/public)

Ahrefs这个“Batch analysis”非常好用，这也是我一直推荐它的原因之一。

![image-1024x565](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-57-1024x565.png/public)

分析之后会得到类似下面的结果，点击“DR”，就可以按照域名的权威性来排名，原名权重越高的网站，说明很多问题，有可能是网站存在时间很长，有可能是网站影响力很大，总而言之，排名越靠前的网站，背后的那个站长是越值得结交的。

![image-1024x590](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/crawler-urls/crawler-urls-image-58-1024x590.png/public)

然后就可以按照这个排序，从高到底把所有网站背后的站长都挖出来。

## 加餐：怎么根据网址找邮箱？

虽然在外贸人面前说这个问题有点班门弄斧，但我一般用[这个工具](https://hunter.io/?via=pew)来找邮箱，挺好用的，其他方法请参考[料神的课程](https://v.imiker.com/?change_chanel=sam)，他把这个话题说到极致了。

如果一个网站的邮箱一直找不到，我也不会浪费太多时间在找邮箱上，好网站一大把，多一个不多，少一个不少。

除非这个网站真的非常好，各方面都吸引了我，我穷尽一切可能也要和背后的站长结交上，否则我真的不愿意倾注过多精力在一项资源上（能让我如此疯狂的网站，在我整个营销生涯也没几个）。

That’s it！有时候做营销工作也不要太死脑筋，有限时间要做尽量多能赚到钱的工作才对。
