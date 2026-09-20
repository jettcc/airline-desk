# 配置与维护

一键启动：macOS双击`Start.command`或运行`bash start.sh`。默认开启服务试用，数据库为`var/interview.sqlite`，从3000–3010选择空闲端口；显式设置PORT时不会改用其他端口。需要Python3.10+和npm，Node24及项目依赖会自动准备。`--classic`关闭试用；`--no-browser`不打开浏览器。启动不会重置数据或自动消费模型额度。

所有命令在项目根目录运行。首次安装见 README。默认本机地址 `http://127.0.0.1:3000`；`PORT=3001 npm start` 可指定其他端口。

| 设置 | 默认/用途 |
|---|---|
| `AIRLINE_DB` | `var/airline.sqlite`，本地用户和业务记录；不会随交付包提供 |
| `PORT` | 3000，仅监听本机 |
| `AIRLINE_SERVICE_TRIAL` | 默认0；1开启本地服务队列、模拟客服及渠道进度。已有未完成渠道任务时不能关掉开关绕过处理 |
| `AIRLINE_FIXED_TIME` | 默认实时时钟；可固定为 `2026-09-18T00:00:00Z` 复现数值边界，网页明确标记 |
| `.env.rightcodes.local` | 参照根目录 `.env.example` 创建，自己的模型凭据，权限0600 |
| 报价 | 5分钟，不锁座，不保留旧政策资格 |
| 会话 | 30分钟闲置、8小时绝对期限；后台轮询不续期 |

## 独立演示数据

先停止使用目标库的服务，再执行：

```sh
AIRLINE_DB=var/demo.sqlite AIRLINE_FIXED_TIME=2026-09-18T00:00:00Z npm run seed -- --reset
AIRLINE_DB=var/demo.sqlite AIRLINE_FIXED_TIME=2026-09-18T00:00:00Z npm start
```

`--reset` 会清除指定演示库的注册账号、订单、会话和防重历史；仅允许 `var/*.sqlite`。新包未附业务库，首次 `npm run seed` 即可，不需要 reset。不要对服务正在使用的数据重置。

服务试用可使用单独库：`AIRLINE_DB=var/service-demo.sqlite AIRLINE_SERVICE_TRIAL=1 npm start`，首次自动初始化，重启不会清除记录。升级schema v2→v3保留原账户、订单和账本，只增加服务状态表；旧操作显示为历史本地记录，不补造渠道回执。如果原库有未完成服务任务，启动未开启试用时会报 `SERVICE_TRIAL_REQUIRED_FOR_PENDING_RESULTS`；重新开启试用核对原请求，或为原作业演示选择独立新库。不要删除原任务来绕过检查。

## 版本与维护

```sh
PYTHONPATH=src .venv/bin/python -m airline_kb verify
node --import tsx scripts/policy.ts verify data/rules/policy-v1.json
```

新政策需要重新审核 PDF、表格、规则与测试，不能仅更新指纹。当前提供一个明确的历史版本兼容路径：原退改算法保留在 `rules-v1.ts` 并核对原指纹，托运行李输入扩展后保留旧业务结果，切换当前规则关联，旧报价需重新获取。任意其他代码变更不会自动迁移，指纹不匹配将拒绝启动。该机制不代表已有通用政策升级系统。

只对虚构对话导出轨迹：

```sh
node --import tsx scripts/export_trace.ts var/demo.sqlite conversation_ID evals/demo-trace.json
```

导出说明完整/缺失状态，不含隐藏推理、会话或确认凭据、模型 Key；金融成功仍以业务事务记录为准。

## 环境检查与复现

`npm run doctor` 检查 Node24、Python依赖/FTS5、政策文件和网页构建，不调用收费模型，也不读取业务数据库。未配置 Key 是警告；本地测试可运行，聊天不可用。测试分层、最新结果见 [VALIDATION](VALIDATION.md)，政策样例和逐步预期见 [DEMO](DEMO.md)。

依赖安装或构建失败时应先核对 Node24，不要在 Node22 构建 native SQLite 后换运行时直接启动。模型接入、费用与限额由使用者的供应商账户管理，本项目不设置或提高额度。
