---
title: WordPress编程小白的学习路径
description: 我相信很多人和我一样，网站需要定制时，就忍不住借助代码的力量，虽然不常用，但用代码解决问题太香了，不用辛苦找插件。
date: 2020-08-08
author: 颜sir
category: marketing
redirectFrom: /wordpress-coding
tags: [wordpress]
---

我相信很多人和我一样，网站需要定制时，就忍不住借助代码的力量，虽然不常用，但用代码解决问题太香了，不用辛苦找插件。

同时我也非常清楚，要记住所有WordPress函数实在困难，好不容易记住并熟练了，三个月一过，基本忘光，还是只能从零开始Google。

所以为了让你熟练运用WordPress的代码，这篇帖子就来总结下WordPress的编程方法，以及最最常用的函数。

记住，要看懂这篇文章，你最好有一点编程基础，至少也要掌握少许PHP的代码知识，否则看起来会比较晦涩。

本文会围绕以下大纲展开：

## WordPress编程的重要概念

首先要搞懂WordPress编程，就必须要明白，WordPress天生只有两种文章类型（post type），分别是：

- Post
- Page

在小白眼里，这两者之前的区别非常大，但如果你渡过小白阶段，你会发现post和page有时候真是傻傻分不清楚。

关于post和page之前的异同点，可以查看这篇文章：[Posts vs. Pages](https://www.wpbeginner.com/beginners-guide/what-is-the-difference-between-posts-vs-pages-in-wordpress/)。

除了以上两种文章类型，还可以手动注册自定义的文章类型，比如books、portfolios、movies等，这些在WordPress编程里统称为“CPT”。

如果想手动注册CPT，需要用在[functions.php](https://www.wpbeginner.com/glossary/functions-php/)中写函数，具体方法可以看这篇[官方文档](https://developer.wordpress.org/reference/functions/register_post_type/)。

如果不想手动写函数，可以下载[Custom Post Type UI](https://wordpress.org/plugins/custom-post-type-ui/)插件或者[Pods](https://wordpress.org/plugins/pods/)插件，这两个插件非常好用，我基本每个网站都必装其中一个。

理解了post type的概念后，就可以在此基础上理解另一个概念：Field，字段。

在默认情况下，每个post type都会有默认的字段，比如标题、正文、摘要和主图等，前面提到的post和page之间之所以有区别，最主要也是因为各自的fields不同，比如post有category和publish date的概念，但page就没有。

当然对应的，每个post type也可以自定义Field，自定义的字段，就是所谓的custom field。

WordPress天生支持添加custom field，添加方法可以参照[这个视频](https://www.youtube.com/watch?v=QwBeyYP99WY)来做，但我一般不用WordPress自带的功能，而是借助插件，插件名字叫“Advanced Custom Field”，没错，大名鼎鼎的“ACF”插件。

补充一句：哪怕不接触WordPress编程，我也强烈推荐你安装CPT和ACF插件，有了CPT+ACF，我们就能用WordPress创造任何文章类型，同时每个文章类型里创造任何我们想要的自定义字段，非常强大。

能理解文章类型（Post Type）和字段（Field）的概念后，剩下的问题就简单了，因为只要解决最最基本的“如何把数据呈现出来”，WordPress就学得差不多了。

所以问题就被简化为：

- 如何呈现文章类型Post Type？
- 如何呈现文章类型里的字段Filed？

在此基础上，就诞生了WordPress编程中两个最重要概念：

- 循环 – loop
- 函数 – function

经过我实战，我发现只需要把以上两个概念搞清楚，其他都是边边角角，都能通过谷歌或Stack Overflow来解决。

## 理解循环（Loop）

在正式阅读前可以先保存[官方文档](https://codex.wordpress.org/zh-cn:%E5%BE%AA%E7%8E%AF)，所谓循环，就是用来批量呈现Post Type的。

要彻底理解循环，就要理解什么叫“查询（Query）”，关于查询可以先保存这个[官方文档](https://developer.wordpress.org/reference/classes/wp_query/)。

WordPress在默认情况下，会根据当前URL从数据库里取数据，假如我现在在文章单页（post singular），它就从单页相关的数据库取数据，假如我在文章归档页（post archive），它就会从文章归档相关的数据库取数据。

**能理解查询后，WordPress编程很多重难点都会迎刃而解。**

比如要呈现网站上当前查询的所有Post Type，就可以用以下代码：

```
<?php if ( have_posts() ) : while ( have_posts() ) : the_post(); ?>
//需要循环呈现的主体
<?php endwhile; else: ?>
<p><?php _e('Sorry, no posts matched your criteria.'); ?></p>
<?php endif; ?>
```

以上是默认情况，如果要自定义当前查询，打个比方，想在第一个循环之外再循环另一个列表，就可以用以下代码：

```
$my_query = new WP_Query( "cat=3" );
   if ( $my_query->have_posts() ) {
       while ( $my_query->have_posts() ) {
           $my_query->the_post();
           the_content();
       }
   }
   wp_reset_postdata();
```

其中“new WP_Query”是以上代码的灵魂所在，即我们创建出来的查询对象，在自定义的查询中，我们循环出来的东西就不会受当前URL的限制了。

## 理解函数（function）

理解了循环，我们就能把任何查询下的字段提取出来，想提取对应Post Type里的Filed，就需要用到函数（function）。

函数有点类似于“规则黑匣子”，比如，现实中的奶牛，就是规则黑匣子，我们把草喂给它，经过它自身一套非常复杂的消化系统，它就会产出牛奶。

我们不必关心这头奶牛的消化体统，究竟是怎么工作的，原理是什么，我们只需要知道，给它喂草，就会产出牛奶即可。

函数也是一样的，我们不必关心函数内部是怎么运行的，我们只要关心给他某个数据，经过它自身的“规则黑匣子”的消化，能返回给我们需要的数据即可。

在不考虑自定义字段和自定义函数的情况下，WordPress有以下几个默认函数，非常常用，使用频次会很高。

### get_the_title()

这个函数可以从数据库取到当前Post Type的标题，以字符串类型返回。

参数：可以往里面传文章的ID或者文章对象。

未完待续……
