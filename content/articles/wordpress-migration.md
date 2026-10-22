---
title: 怎么迁移WordPress网站？
description: 写在最前面：绝大多数新购买的空间，都会提供一次性的迁移服务，他们的技术人员会帮你免费迁移网站，在查看本教程之前，可以先问下空间的客服，看能不能免费迁网站，如果可以，那就不必花时间读这篇文章了。
date: 2022-07-23
author: 颜sir
category: marketing
redirectFrom: /wordpress-migration
tags: [wordpress, hosting]
---

写在最前面：绝大多数新购买的空间，都会提供一次性的迁移服务，他们的技术人员会帮你免费迁移网站，在查看本教程之前，可以先问下空间的客服，看能不能免费迁网站，如果可以，那就不必花时间读这篇文章了。

以下正文：

---

很多新手对迁移WordPress网站感到畏惧，因为听上去就很麻烦，但作为几乎隔几天就要自己迁一次网站，或帮朋友迁移一次网站的人来说，迁移网站比出门买杯咖啡还要轻松。

迁移WordPress网站很简单，只需要以下几个步骤：

1. **在旧网站导出数据包；**
2. **把域名转移到新空间；**
3. **在新空间安装WordPress；**
4. **在新网站导入数据包；**
5. **保存固定链接并检查全站。**

以上留个步骤适用于任何WordPress空间和网站，哪怕你的空间是用VPS搭建的，也同样可以用这个方法完成迁移。

这篇文章我会就以下大纲详细展开说明：

## 用All-in-One插件导出数据包

在淘宝买卖东西，大体流程是，首先卖家把商品打包好，然后卖家把东西发出去，买家收到货之后再拆快递，这样就完成了整个交易。

WordPress迁移网站也是一样，也是“打包→发货→收货→拆快递”这个过程，所以第一步就是把旧网站的内容都打包好。

WordPress有个傻瓜式的一键发货插件，叫作[All-in-One WP Migration](https://cn.wordpress.org/plugins/all-in-one-wp-migration/)，在WordPress的“插件→安装插件”搜索就能找到：

![image-1024x419](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-116-1024x419.png/public)

然后WordPress后台左侧，就会多出一个叫“All-in-One WP Migration”的菜单，我们点击菜单当中的“导出”：

![image-1024x548](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-117-1024x548.png/public)

再下一步，你会看到有多种导出的方式，最普通的就是选“文件”，这样我们就可以把数据包下载到我们自己电脑上。

![image-1024x556](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-119-1024x556.png/public)

注意：如果你和我一样有大量迁移网站的需求，不妨买一个[All-in-One高级版](https://servmask.com/products/google-drive-extension)，可以直接把网站导出到谷歌云或者Dropbox，而不必把文件下载到自己电脑，这样速度会飞快，而且不受自身网速影响。

价格有点小贵，第一次买是99美金，之后每个月续费19美金，但如果迁移量大，这点钱就无所谓了。

我平常用的就是Google Drive版，200MB的网站，5分钟就能迁移好。

这个教程我还是以最平常的手段来做，我们选择“文件”，将整个数据包下载到本地：

![image-1024x530](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-118-1024x530.png/public)

点击之后它会自动读取网站的数据，准备打包，这一步要等待几分钟：

![image-1024x394](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-120-1024x394.png/public)

![image-1024x377](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-121-1024x377.png/public)

等插件打包好网站所有的文件和数据库之后，就会是下面这个提示，点击下载，就能把数据包下载到自己电脑：

![image-1024x356](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-122-1024x356.png/public)

## 把域名转移到新空间

首先在新空间上新建一个网站，这里以Hostinger为例。

进入后台后点击导航上的“Hosting”，然后点击“Add Website”：

注意，每个空间新建网站的方式不一样，具体可以谷歌“How to add a new website on xxx”。

![image-1024x374](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-126-1024x374.png/public)

点击之后输入老域名，设置个密码（此处的密码无关紧要）即可：

![image-1024x391](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-127-1024x391.png/public)

之后要管理网站，只需点击导航条的Hosting，就能找到对应域名的“Manage”：

![image-1024x373](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-128-1024x373.png/public)

现在我们就相当于跟新空间就“打好招呼”了，接下来就是把域名的控制权也转过来。

要转移域名控制权，只要修改下DNS即可，首先进入我们购买域名的地方，比如我的域名是在[NameSilo](https://www.namesilo.com/)上买的，那就到后台修改DNS：

![image-1024x363](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-132-1024x363.png/public)

每个平台修改DNS的地方不一样，如果找不到修改的地方，可以在谷歌搜索“How to change DNS in xxx”即可，比如我搜“How to change DNS in namesilo”，就能搜到一大堆教程：

![image-1024x568](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-124-1024x568.png/public)

我们需要把域名的DNS信息，改成新空间指定的DNS即可，每个空间的DNS信息不一样，还是谷歌大法，可以搜索：where can I find my nameservers on xxx，这里以Hostinger为例：

![image-1024x522](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-125-1024x522.png/public)

比如我要把网站搬迁到[Hostinger](https://www.xunpanziyou.com/specs101)上，我只需要根据以上教程，进入到域名的管理页面：

![image-1024x373](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-129-1024x373.png/public)

选择截图中的Details：

![image-1024x463](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-130-1024x463.png/public)

就能找到我这个域名的NameServe应该是ns1.dns-parking.com和ns2.dns-parking.com。

![image-1024x488](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-131-1024x488.png/public)

回到NameSilo的后台，将这两个地址填进去，保存即可。

![image-1024x429](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-133-1024x429.png/public)

完成之后这一整个步骤就搞定了，接下来就要等2-24小时，等域名的DNS信息在全球范围内更新。

## 在新空间安装WordPress

等域名的控制权转移成功之后，就可以在新空间建立新网站了，如何验证域名的控制权是否转接成功？可以在[这个网站](https://mxtoolbox.com/)输入网址地址查一下：

![image-1024x436](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-135-1024x436.png/public)

等下面的几个地址变成对应的新空间的地址就大功告成，这一步不要着急，快则几分钟长则一整天：

![image-1024x560](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-136-1024x560.png/public)

生效之后，在新空间就可以找到对应的地方安装WordPress，如何安装？照例还是谷歌大法“How to install WordPress on xxx”，以Hostinger为例：

![image-1024x558](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-137-1024x558.png/public)

按照它的教程，我们可以在后台找到一个叫“auto installer”的东西，点击图中的WordPress：

![image-1024x495](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-138-1024x495.png/public)

做如下设置后就可以点击install了，这一步不重要，因为之后我们网站反正是会覆盖掉这些信息的，所以随便设置都无所谓：

![image-1024x587](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-139-1024x587.png/public)

之后就可以点击下面截图的按键，进入新网站后台（如果点不进去再等半小时）：

![image-1024x444](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-141-1024x444.png/public)

至此，这一步就算走完了。

## 在新网站导入数据包

打开网站后台之后，点开“插件→安装插件”，安装最开始我们提到的All-in-One插件：

![image-1024x512](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-142-1024x512.png/public)

然后点击“导入”：

![image-1024x552](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-143-1024x552.png/public)

如果你的数据包不到128MB，这一步就可以直接选“FILE”导入，如果你和我一样数据包比较大，那就要额外多安装截图中的插件：

![image-1024x472](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-144-1024x472.png/public)

点击[这个链接](https://import.wp-migration.com/all-in-one-wp-migration-file-extension.zip)可以直接下载对应插件，下载好之后，在后台通过“Plugin→Add New→Upload Plugin”，上传激活即可：

![image-1024x422](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-145-1024x422.png/public)

![image-1024x479](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-146-1024x479.png/public)

激活之后就能继续上传了，点击“FILE”选择之前导出来的数据包：

![image-1024x542](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-147-1024x542.png/public)

最后静静等待进度条到100%：

![image-1024x406](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-148-1024x406.png/public)

进度条满了之后会出现这个界面，选择右边的PROCEED：

![image-1024x448](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-149-1024x448.png/public)

继续等待直到截图中的数字变成100%：

![image-1024x406](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-150.png/public)

完成之后是下面这样的界面，看到这个页面就可以关掉网站，重新从空间登录网站后台了：

![image-1024x409](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-151-1024x409.png/public)

## 保存固定链接并检查全站

再次进入后台，你会发现网站已经迁移成功了，不过还需要保存下固定链接，否则会出现只有首页正常，其他页面都打不开的情况。

稍微讲下原理：这是因为All-in-One插件虽然能帮你迁移网站的文件和数据库，但有个关键的文件.htaccess它没法自动生成，而这个文件是负责整个网站URL rewrite的，而我们在后台保存固定链接，就能重新生成.htaccess，让网站正常工作。

进入WordPress后台的设置→固定链接（Permalink），直接点击最下方的“保存”即可：

![image-1024x550](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/wordpress-migration/wordpress-migration-image-153-1024x550.png/public)

到这一步，网站就完全迁移成功了！最后再彻底检查下网站各个页面是否正常（一般都正常，极少出问题），我们的任务就Over了。
