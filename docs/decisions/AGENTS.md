# 决策记录规则

`docs/decisions/` 只保存已经确定的 Accepted Decision，覆盖产品、架构、数据、设计、AI、实现、安全、运营、治理等主题。未决调研、方案比较和进度记录放在相应的其他文档或工作跟踪载体中。

一个稳定主题使用一个 `NNNN-topic.md` 文件；只有新独立主题才新建记录。主题改变时更新原文件，不新建替代链，也不写“替代/被替代”元数据。当前决定放在记录上方并优先于历史内容；反转决定时更新上方当前内容，追加语义修订及原因，并保留旧修订原文。语义修订记录放在下方并按日期倒序；逐行修改交给 Git 历史。排版、链接和纯措辞调整不增加语义修订。“不采用”只记录真正排除的方案，不把尚未实施或延期事项写成拒绝。

记录结构固定如下：

```markdown
# 决策记录 NNNN：中文主题

* 状态：Accepted
* 类型：Product
* 决策简述：一句话
* 当前修订：YYYY-MM-DD

## 当前决定

## 理由

## 不采用

## 关联事实载体

## 修订记录

### YYYY-MM-DD
初始或语义调整说明
```

类型只能是 `Product`、`Architecture`、`Data`、`Design`、`AI`、`Implementation`、`Security`、`Operations`、`Governance` 或 `Other`。决策记录说明原因和取舍，不复制数据定义或实现状态；VISION 表达长期理想状态，Issues/Milestones 记录动态计划与进度，代码和测试是实现事实。已有的规格、架构等权威文档通过链接引用，不为占位而新建空文件。`Accepted` 表示取舍已确定，不表示能力已经实现。

维护记录时先查 [决策索引](index.md) 定位主题，再更新记录的当前决定、元数据和语义修订，必要时同步实际权威文档，最后运行：

```sh
bash docs/decisions/generate-index.sh
bash docs/decisions/generate-index.sh --check
git diff --check
```

索引由脚本生成，不手工编辑。脚本无参数时生成索引，`--check` 只校验索引是否与记录一致。

修改索引脚本时，运行 `bash docs/decisions/test-generate-index.sh` 验证生成、只读检查和非法记录处理。

机制参考：[HotCP initial `docs/decisions`](https://github.com/HotCP/HotCP/tree/initial/docs/decisions)。
