---
title: 在哪里注册域名？
description: 搞懂域名大概意思后，第一个实际问题就是到哪里注册域名。
date: 2020-06-18
author: 颜sir
category: marketing
redirectFrom: /domain-register
tags: []
---

搞懂域名大概意思后，第一个实际问题就是到哪里注册域名。

可以在国内注册，也可以在国外注册，两个我都会介绍下，但最好在国外注册，因为在不用CDN的情况下，国外DNS的解析速度明显会比国内快很多。

## 国内

如果是国内，我首推[阿里云)](//wanwang.aliyun.com/)，阿里云把万网买下来后，域名服务这块就做得极好。

点击上面链接进入后，在域名栏里输入想注册的域名。

![image-1019x305](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-1505-2019-12-15-22-11-15.png/public)

点击查询域名后，就会看到所有还能买的域名。

![image-488x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-2166-2019-12-15-22-13-00.png/public)

域名购买就没什么好说了，按照阿里云的流程来就行，这里不展开讲，因为通常不会在国内买，国内随便买个域名都要实名认证，做过网站还要层层备案，实在不方便。

下面我会把国外平台买域名的方式讲详细点。

## 国外

如果是国外，我首推[NameSilo](//yansir.vip/go/namesilo)，NameSilo这个网站看起来破破烂烂，但一直很稳定，属于域名服务商里的大佬，而且价格正常，童叟无期，除开在买域名的时候注意躲开它额外的收费项，其他都很好。

点击上面链接进入后，在搜索框输入想注册的域名。

![image-653x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-2352-2019-12-15-22-20-00.png/public)

然后把`.com`或其他你想要注册的后缀给勾选上，点击下面的“register checked domains”。

![image-892x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-2367-2019-12-15-22-20-48.png/public)

下一个页面，NameSilo的第一个赢利点“域名保护”服务就跳出来了，虽然NameSilo声称该服务：

1. 降低DDOS攻击风险
2. 通过DNS缓存加快网站加载速度
3. 提供额外安全层来防黑客

但真有人想用DDOS攻击你，真有人想黑你，NameSilo这类服务是明显不够看的，所以果断选择“NO”。

![image-587x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-8444-2019-12-15-22-22-58.png/public)

再下一个页面，可以参考我的选项来调整，“Auto-Renew”选“No”，“Privacy Setting”选“WHOIS Privacy”，“Set all years to”选“3年”：

![image-662x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-5868-2019-12-15-22-30-36.png/public)

逐个来解释下上面的选项是什么意思。

1. Service Link：可以直接选择第三方服务，然后链接过去，比如选了“G-suite”，那域名购买好后，DNS就直接变成谷歌企业邮箱的DNS，不用再麻烦修改，选“Shopify”也是，直接帮你把DNS改好，如果你是建立WordPress网站的话，那这个选项就用不到了；
2. NameServers：在上一个选项没做选择的情况下，可以直接填DNS服务器，比如买了siteground空间，或者打算用cloudflare的CDN，那可以在这里填对应的DNS地址，这样就免去了购买后修改的麻烦；
3. Auto-Renew：勾选上之后就会自动续费，适用于信用卡或有签约功能的支付方式，但如果用的是支付宝，那就没法自动续费，所以一般这里选择“No”就行了，反正域名到期之前会有邮件提示；
4. Privacy Setting：隐私设置，可以把whois的信息给隐藏掉，在默认状态下，NameSilo的域名卖出去后，任何人都可以通过像[WHO.IS(target=\_blank)](//who.is/)这类查询工具查到你域名所属的姓名、邮箱、地址、电话号码等信息，所以我们的邮箱在注册好之后，天生就是暴露出去的，网上发垃圾邮件的人抓到邮箱，就能给我们发垃圾邮件，所以这里勾选隐私设置，可以一定程度减少垃圾邮件的量；
5. Set all years to：相当于设置注册时间，默认情况下，NameSilo的注册时间是1年，我们也可以直接购买更多年份，最多不能超过10年；
6. Next Disccount：这是NameSilo搞的促销活动，在我的截图里，它提示“49 more registrations”，意思是，再在NameSilo上购买49个域名，我就能获得一定的折扣……怎么说呢，总感觉这个营销手段有点沙雕。

在购买之前，还可以填一个Coupon，因为从米课推荐过去买域名的人挺多，所以米课干脆申请了个优惠码，只要填入`IMIKER`，那就能减免1美金。

![image-662x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-5455-2019-12-15-22-50-01.png/public)

点击下一步，就进入到注册或登录页面，如果之前有NameSilo的账户，那就在下面图中填账户密码后登录：

![image-640x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-2374-2019-12-15-22-51-19.png/public)

如果没有账户，那就在下面图里填写完整信息：

![image-848x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-7385-2019-12-15-22-52-45.png/public)

下面的隐私信息可以照着我的提示填：

![image-306x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-4229-2019-12-15-22-57-15.png/public)

填完之后，点击“Create My New Account”即可，之后登录NameSilo都是用这个账户。

再然后就是打钱环节了，其他付款方式都行，比如信用卡或PayPal，但因为中国人购买量大，所以NameSilo也推出了支付宝付款的方式。

注意，一定要先在空白区填自己支付宝账号，再勾选支付宝，否则会有错误提示：

![image-676x316](https://imagedelivery.net/oau5CjFVr02uMnKIpWStog/articles/domain-register/domain-register-1592550723-4432-2019-12-15-23-00-21.png/public)

最后扫码付款就购买成功了。
