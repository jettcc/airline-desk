# M1 接口、复现与限制

## 使用范围

资料来源是三份现有旅客政策，共 18 页、13 张表格、75 个片段（含每份文档的元信息）。作业说明不进入业务知识库。没有接入订单、支付、身份或大模型，也不会自然语言编造答案。

导入和检索工具使用 Python；这不决定后续网页/主应用语言。未来可以通过本地进程或服务适配调用，向量检索也可替换当前检索实现。

## 查询接口

```python
from airline_kb import KnowledgeBase

kb = KnowledgeBase("data/knowledge")
result = kb.search(
    question="改签差价与税费可以抵扣吗",
    airline="BHA",
    request_at="2026-09-18T00:00:00Z",
)
```

- `question`：1～4000 字符。
- `airline`：NSA/BHA/STA，或对应名称/目录别名。可从问题中识别唯一已知航司，不能猜未知航司。
- `compare=True`：显式允许比较多个航司，不与单一 `airline` 同时提供。
- `request_at`：带时区 ISO 时间；省略时使用当前服务端 UTC。是请求时间，不是原出票时间。原出票条件保留在证据中，由规则模块处理。
- `release_id`：可选历史知识发布标识。省略则每次查询开始时读取一次 `CURRENT`。

### 返回值

| 字段 | 含义 |
|---|---|
| `status` | 证据检索状态，不是业务审批结果 |
| `release_id` | 本次使用的完整知识版本 |
| `purpose` | 固定 `policy_evidence_only` |
| `booking_decision` | 固定 `NOT_EVALUATED` |
| `airlines` / `topics` | 实际查询范围和识别主题 |
| `evidence` | 主题关联的完整章节，包括必要例外；每项保留原文及结构化表格 |
| `candidates` | 全文检索的补充候选；未经证明可以独立回答问题 |
| `required_booking_facts` | 对应主题办理时需要核验的事实种类；不表示用户已经提供 |
| `citation` | 每项依据的航司、版本、章节、页码、源指纹及快照 PDF 路径 |
| `trace` | 使用的检索方式、全文候选标识；不含模型隐藏推理 |

引用路径由当前环境生成绝对路径；快照内部保存相对路径，所以整个项目移动到另一个目录后仍可使用。

### 状态与使用约束

| 状态 | 如何处理 |
|---|---|
| `FOUND` | 找到已识别主题对应的证据。它不保证问题中每个未识别细节都有答案；解释者必须确认原文支持具体结论，办理者必须核验事实 |
| `NEEDS_CONTEXT` | 缺航司、范围矛盾、多个航司未指定比较等；先澄清 |
| `NO_EVIDENCE` | 未匹配主题、未提供的航司、或文档明确未规定的问题；可附范围声明/候选，但不能捏造答案 |
| `UNSUPPORTED_PERIOD` | 请求时间早于当前文档适用日期，不套用现在的规则 |
| `REVIEW_REQUIRED` | 导入遇到未审核源变化、表格或章节不匹配；不发布 |
| `INVALID_INPUT` | 输入不合法，例如不带时区或非法版本标识 |
| `UNAVAILABLE` | 没有发布版本、索引/文件校验失败等；不能用部分内容冒充成功 |

Python 接口对操作错误抛出带 `code` 的 `KnowledgeError`；调用者还需处理 I/O/SQLite 异常。命令行适配器将这些异常转为失败 JSON 并以退出码 2 结束。业务性的缺范围/无依据查询返回 JSON，退出码为 0。

## 可复现查询案例

以下命令前缀均为 `PYTHONPATH=src .venv/bin/python -m airline_kb`，时钟使用 `--request-at 2026-09-18T00:00:00Z`，除历史日期案例外。

| 命令参数 | 应看到 |
|---|---|
| `search '改签' --airline BHA` | `FOUND`，包括 2.1、2.2、Appendix A；$55/$85 与出票分界同时保留，差价和税费没有遗漏 |
| `search '退票' --airline NSA` | `FOUND`，包括 3、3.1、3.2、4、5、6 系列；额度/退税/异常均有原文 |
| `search '行李' --airline STA` | `FOUND`，7 系列、国内/国际表及加购 23kg 限制 |
| `search '行李' --compare` | 按 BHA/NSA/STA 标记来源，不能合并成一份通用额度 |
| `search '退票'` | `NEEDS_CONTEXT`，不会默认航司 |
| `search 'Northstar refund' --airline BHA` | `NEEDS_CONTEXT`，不会偷偷替换航司 |
| `search '宠物可以托运行李吗' --airline BHA` | `NO_EVIDENCE`，说明宠物未覆盖，即使行李主题同时有依据 |
| `search 'service-desk' --airline NSA` | `NO_EVIDENCE`，有全文候选，不把候选当完整答案 |
| `search '改签' --airline BHA --request-at 2026-06-30T23:59:59Z` | `UNSUPPORTED_PERIOD` |

## 发布与并发复现

- 连续运行两次 `build`：返回相同发布标识，第二次 `reused=true`，不重复收录。
- 在隔离副本修改政策 PDF 再运行 `build`：`REVIEW_REQUIRED`，`CURRENT` 不变。不要在正式原文件上演示损坏。
- `verify`：逐一核对发布清单和所有文件指纹，再检查 SQLite 完整性及片段数量。
- `activate <release_id>`：在文件锁保护下切换到已存在且核验通过的版本；用于明确回退，不自动挑选旧版。
- `search ... --release <release_id>`：明确查询历史快照，结果仍指向对应历史 PDF。
- 测试套件在临时副本中实际执行多进程导入、120 次并行查询、新版发布时的并发读取、指针替换故障和索引损坏。

当前依赖本地 POSIX 文件锁与同文件系统原子重命名；不是多机分布式发布方案。已发布文件按不可变约定管理，常规工具不会修改；外部手动损坏会在查询校验时失败。没有对恶意操作者同时替换整个发布清单提供数字签名认证。

## 当前限制

- 解析器针对当前三份可提取文字的 PDF 做过核对，不宣称适用于任意扫描件、复杂版式或其他文档格式。
- 中英文依赖受控主题词和已验证的表达；未知表达可能只返回候选或要求澄清。没有宣称达到通用语义检索召回率。
- 采用较完整的章节证据保证例外不被 top-k 截掉，返回内容可能较长。对话模块以后可以在保留依据完整性的前提下组织回答。
- 文件指纹与已核对表格用于阻止未经复核的更新，不会自动理解任意新版政策之间的语义冲突。
- 当前不会计算真实订单最终金额；实际税额、支付工具、资金是否已退、交易是否结算，属于后续业务事实。
- 源版本与业务规则联合启用已经确定为契约，但 M2 尚未实现，当前只验证知识版本内部一致性。
- 本次并发验证覆盖同机读者隔离和发布一致性，不代表已实现订单并发、幂等退款或完整多用户应用。

## 技术依据

[SQLite FTS5](https://www.sqlite.org/fts5.html) 提供本地全文检索；[Python os.replace](https://docs.python.org/3/library/os.html#os.replace) 用于同文件系统的原子指针替换。完整发布校验、历史快照、读者版本固定和写锁由本模块实现并测试。
