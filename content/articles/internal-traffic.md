---
title: 如何排除GA的内部流量？
description: 如果你的IP不怎么变化，那查询到你的IP地址，然后在GA中排除对应流量即可。
date: 2022-06-18
author: 颜sir
category: marketing
redirectFrom: /internal-traffic
tags: [analytics]
---

如果你的IP不怎么变化，那查询到你的IP地址，然后在GA中排除对应流量即可。

如果你和我一样，梯子的IP一直在变动，自己的IP永远是动态在变化，那就可以尝试以下方法。

## 给自己添加特殊cookie

在浏览器（全篇以谷歌浏览器作为示例）中，随便进入一个页面，比如imiker.com，用浏览器自带的书签功能收藏网页，会弹出如下提示：

![image-748x315](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-6105-2019-12-27-19-40-52.png/public)

点击更多，把名称改为“内部流量”。

![image-678x230](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-5155-2019-12-27-19-43-08.png/public)

网址改为如下代码：

![image-623x189](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-6398-2019-12-27-19-44-23.png/public)

```js
javascript:function%20setCookie(cname,%20cvalue,%20exdays,%20cdomain)%20%7B%20var%20d%20%3D%20new%20Date()%3B%20d.setTime(d.getTime()%20%2B%20(exdays*24*60*60*1000))%3B%20var%20expires%20%3D%20%27expires%3D%27%2B%20d.toUTCString()%3B%20document.cookie%20%3D%20cname%20%2B%20%27%3D%27%20%2B%20cvalue%20%2B%20%27%3B%27%20%2B%20expires%20%2B%20%27%3Bpath%3D/%20%3B%20domain%3D%27%20%2B%20cdomain%3B%7D%20setCookie(%27InternalTraffic%27,%20%27true%27,%20365,%20window.location.hostname)%3B%20alert(%27Cookie:%20%20InternalTraffic%5CnValue:%20%20%20%20%20TRUE%5CnDomain:%20%20%27%20%2B%20window.location.hostname)
```

保存后，书签就创建成功了，成功后是这样的：

![image-904x374](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-8349-2019-12-27-19-45-02.png/public)

进入你自己网站的首页，点击这个书签，会弹窗提示：

![image-494x216](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-8843-2019-12-27-19-49-34.png/public)

为了确认添加成功，可以进入浏览器的cookie管理中心，看有没有加进去。

1、点击浏览器右上角的三个小点，进入设置

![image-718x302](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-1182-2019-12-27-19-51-31.png/public)

2、在设置中搜索cookie，找到“网站设置”选项

![image-1178x502](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-5907-2019-12-27-19-52-37.png/public)
![image-1120x398](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-3661-2019-12-27-19-52-40.png/public)

3、在“权限”下，进入“cookie和网站数据”，点击“查看所有cookie和网站数据”

![image-1438x464](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-7678-2019-12-27-19-53-43.png/public)
![image-1338x630](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-6569-2019-12-27-19-53-38.png/public)

4、在cookie列表中搜索自己域名，并点击进入

![image-791x283](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-9916-2019-12-27-19-55-24.png/public)

如果成功的话，你会在列表里看到“InternalTraffic”，如果没成功的话，那就要再把上面的步骤，好好再实践下。

这一步非常重要，如果设置不成功，后续也不会成功，切记切记。

成功后，你可以先在自己的常用设备和常用浏览器中进入网站并点击书签，然后，你还可以把这个书签，分享给你公司所有人，让他们登录自己常用设备和常用浏览器，进入你的网站，并点击这个书签。

这样就相当于把自己人都标记了出来，方便后期把自己人产生的所有流量都剔除掉。

在GA中创建自定义维度
打开GA，点开“管理”，在媒体资源下选中你的网站，点击“自定义定义”并点击“自定义维度”：

![image-2338x1200](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-6218-2019-12-27-20-03-34.webp/public)

然后添加如下对应信息并保存：

![image-2042x848](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-8714-2019-12-27-20-04-32.png/public)

创建成功后是下面这样的，记得索引里面的数字很重要，等下要用到，比如我的数字是1：

![image-1874x544](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-5187-2019-12-27-20-05-22.png/public)

关联cookie和自定义维度
打开GTM，进入“工作区”，点开“变量”，在“用户定义的变量”下“新建”：

![image-2054x1200](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-9138-2019-12-27-20-09-26.png/public)

然后做如下配置：

![image-2990x1034](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-8583-2019-12-27-20-12-35.png/public)

切记，cookie名称一定不能填错，因为我们制作的书签，会给我们自己的网站添加一个“InternalTraffic”的标记，那么我们为了保持一致，也要一字不差地填写这个名称，大小写都不能错。

直接复制粘贴吧 >> InternalTraffic

保存后，会在你的自定义变量下多出一个“内部流量cookie”的变量。

![image-2220x738](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-9229-2019-12-27-20-15-26.png/public)

然后点开你的GA追踪ID的变量：

![image-1643x924](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-8491-cba1c17cae8e20e0f4d7a5a22551.png/public)

点开“更多设置”，添加如下自定义维度：

![image-3306x1488](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-9448-2019-12-27-20-19-55.png/public)

保存好之后，选择右上角的“提交”，然后发布。

![image-2826x964](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-9028-2019-12-27-20-30-13.png/public)

发布成功后，我们的cookie就和GA中自定义的维度挂钩了。

在GA中创建过滤器
打开GA，在数据视图下添加过滤器，注意添加过滤器会对数据造成永久破坏，所以通常不建议在原始数据下直接加过滤器。

你可以复制一份原始数据，然后再操作：

![image-3266x1354](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-2366-2019-12-27-20-22-09.png/public)

添加一个过滤器，配置信息如下：

![image-2778x986](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-9651-2019-12-27-20-24-26.png/public)

其中“过滤字段”下的“内部流量”可能不太好找，你要划到最下面，有个“自定义维度”，而且颜色是绿色的，选那个就对了。

![image-2758x1230](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-4780-2019-12-27-20-26-19.png/public)

还有，true不要填成了ture，我猜很多人会闹这个笑话。

都填好后选择保存，保存成功后，过滤器列表中就会多出一个“排除内部流量”。

![image-1872x684](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551440-5147-2019-12-27-20-28-15.png/public)

测试
首先进入你网站任意页面，并在链接后添加/?internal，打个比方，https://www.xunapnziyou.com/?internal，就可以成功标记了（记得在所有浏览器上都访问一遍）。

同时为了看出标记成功的效果，可以进入你网站相对冷门，不常有人访问的页面。

然后打开GA的“实时”下的“内容”，你会发现此时GA完全无法追踪到你。

这就说明，我们的方法已经完全生效了。

![image-2666x1298](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-8674-2019-12-27-20-36-05.png/public)

为了验证确确实实已经生效，可以做个对比试验。

首先进入浏览器的cookie管理中心， 把自己网站的对应cookie给删掉：

![image-776x293](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-2010-2019-12-27-20-37-00.png/public)

删掉之后，刷新一下你网站的页面，然后刷新GA，你会发现，又可以追踪到了：

![image-2620x1066](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-6163-2019-12-27-20-39-56.png/public)

通过对比试验就能说明，我们的方法确确实实成功排除了内部的无效流量。

试验结束，再次进入网站首页，使用书签：

![image-988x432](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/internal-traffic/internal-traffic-1592551441-9283-2019-12-27-20-41-40.png/public)
