# TabWall 数据可靠性与恢复闭环修复

- Status: in-progress
- Updated: 2026-09-13
- Branch/worktree: D:\06-project\TabWall（直接工作目录）
- Base commit and relevant uncommitted changes: 无 Git 仓库，无法提供基准提交或未提交差异。当前版本 0.2.9；源码包含图标视图、empty-state[hidden] 修复、批量恢复逐项捕获异常。执行前记录相关文件 SHA256 并复制源码备份。
- Planner: GPT-6 Astra
- Executor: GPT-5.6 Luna

## Objective

交付一个可在真实 Edge 中验证的可靠版本：重启后收藏仍在；并发操作不覆盖记录；错误不伪装成空列表；全部恢复结果可见、可重试；旧记录有独立保全和恢复入口。版本维持 0.2.9。

## Current state and evidence

- 2026-09-13 只读检查 Default 配置：安装 ID 为 nbgjphihpnjhnepceafejfcchflefdhn，加载路径 D:\06-project\TabWall。不能继续假定用户使用旧 release 目录。
- 原先的列表整体覆盖路径已移除；后台和管理页现在通过 storage-command 访问 IndexedDB 事务库。并发 capture 已用隔离测试复现并验证不再丢记录。
- 管理页现在区分成功空列表和存储错误，错误保留已有卡片并提供重试；focus、visibilitychange 和 storage-updated 会触发刷新。
- 恢复改为按记录 ID，在目标窗口逐项创建/复用延迟页，返回 created/reused/failed 统计，保留收藏；延迟页激活时由后台按 ID 查询记录后才加载目标 URL。
- lazy-tab.html 已改为外部 lazy-tab.js，未放宽 MV3 CSP。
- 本地 LevelDB 日志路径：C:\Users\Administrator\AppData\Local\Microsoft\Edge\User Data\Default\Local Extension Settings\nbgjphihpnjhnepceafejfcchflefdhn\000003.log。只读解析发现历史 71/70/68 条列表、多次 delete、最后序号 130 有 1 条。工具 work/inspect-storage.cjs 尚未验证 CRC，结果只是恢复线索，不是当前 chrome.storage API 状态证明。
- 源码无持久测试套件、无回收站和快照；release/TabWall-v0.2.9 及 ZIP 曾与源文件不一致。
- 官方契约：storage.local 跨重启持久存在；卸载会删除数据。参见 https://developer.chrome.com/docs/extensions/reference/api/storage/ 。

## Assumptions and decisions

1. 保持原扩展 ID、安装路径、浏览器配置；不卸载、不生成 manifest key、不操作用户真实浏览器的关闭/批量恢复来做测试。
2. “恢复”统一为在浏览器打开，保留收藏；只有删除/清空会移出当前列表，进入可恢复状态。该选择依据用户反复要求避免丢记录；同步更新按钮提示。
3. 使用原生 IndexedDB 事务作为收藏唯一权威库，解决多页面、多服务进程并发。chrome.storage.local 保留旧数据作为迁移来源和用户偏好存储，不双写两份权威收藏。
4. 普通/隐私范围始终隔离。不能假定普通和 split 服务进程共享 JS 队列；每次变更依靠数据库事务和 scope 校验。
5. 已有完整列表可以正常迁移；历史日志的不同时间列表不可直接全部拼接后覆盖用户数据。历史恢复需先生成可审阅文件，再通过显式导入合并。

## Scope

数据保全、一次性迁移、事务读写、可恢复删除、导入导出、可见错误、完整恢复、跨页面刷新、真实重启验收、固定测试入口。

## Out of scope

云同步、账号、AI、新分类算法、重新设计 Logo、自动升级版本、自动打包/商店发布、Git 初始化、清理旧发布包。原网页自动关闭暂不新增，保留现有收纳行为。

## Contracts and data changes

新增 storage-db.js（普通脚本导出 globalThis.TabWallStore，可由 background.js 的 importScripts 加载，管理页和测试亦可使用）。IndexedDB 名称 tabwall，版本 1：

- meta：keyPath key；每 scope 的 schemaVersion、revision、migrationCompleted。scope 取 normal/private。
- tabs：keyPath id；scope 索引；字段 id(UUID)、scope、url、title、favIconUrl、originalOrder、position、savedAt、lastAccessed、deletedAt(null/时间戳)。普通重排只变 position，保留 originalOrder；现有 Original 视图按用户 position 展示。
- snapshots：keyPath id；scope、createdAt、reason、revision、tabs。批量删除/导入前保存快照，每 scope 最多 5 个；回收站保留至用户显式永久删除，不在本轮新增永久删除入口。

每个改变收藏的命令在一个 readwrite 事务中完成读取、变更、revision+1，成功响应必须等待 transaction.oncomplete。事务内不等待网络或 chrome.tabs API。配额/中止错误不得当成功返回；保留旧状态。id 稳定，不再使用 url/title/index 拼接作身份。

首次迁移从旧 tabwallSession / tabwallSessionPrivate 读取，验证 schema 后，按 scope 在同一事务检查 migrationCompleted 并写入记录/标记；并发迁移只允许一次，失败不标记完成，旧键不删除。格式损坏报告错误，不自动写空集合。缺失旧键表示新安装来源为空，但仍提供历史导入入口。不得在已迁移数据库被清空后重新隐式导入旧键。

命令接口：list(scope)、capture(scope,tabs)、reorder(scope,ids)、trash(scope,ids)、clear(scope)、restoreTrash(scope,ids)、import(scope,document)、export(scope)。capture 在事务中按规范化后的完整 URL+title 去重，不去掉 query/hash；导入重复也按同规则合并。reorder 对未提交的新条目保留并追加，未知 ID 忽略，重复 ID 拒绝。

后台是 UI 命令入口：storage-command 消息，返回 {ok:true,revision,data} 或 {ok:false,code,message}。scope 从扩展调用者上下文核验，不直接相信任意消息字段；只允许本扩展调用。后台提交后发送 storage-updated 通知；管理页同时在 focus/visibilitychange 时重新 list，避免漏消息。并发 list 用请求序号丢弃过期结果。

恢复命令由后台从数据库按 scope+ID 获取条目，禁止接受任意目标 URL 作为数据库内容。目标窗口为发起管理页所在窗口并校验隐私一致。当前窗口已有普通/延迟目标 URL 按队列逐一匹配，保留同 URL 多收藏的一对一数量，不把其他窗口已有页面视为已恢复。逐项尝试，返回 {created,reused,failed,failures:[{id,message}]}；失败不中断其他项，不删除收藏。同管理页恢复期间禁止重复提交，后台按 scope+windowId 合并同一在途操作。完成后聚焦第一个可用目标；其余页面延迟加载。

lazy-tab.js 外置初始化标题与消息，在页面可见/激活时发消息请求后台加载目标；后台核验 sender.tab 是本扩展 lazy-tab.html，目标仅允许 http/https，兼容 url 和 pendingUrl。同一标签重复激活应幂等；后台 onActivated 作为补充。

## Implementation steps

- [x] 1. 保全证据：只读导出当前扩展 chrome.storage.local（普通/隐私键分别处理），记录 ID/路径/配置；复制已识别数据库中可读日志和 manifest 到项目 work/recovery/<时间>/，记录哈希。锁定文件不强行解锁。先保全再迁移。活跃数据库文件副本需标记非原子快照，不宣称完整备份。
- [x] 2. 在副本上完善 work/inspect-storage.cjs：验证 LevelDB 记录 CRC32C、分片和 WriteBatch 边界。输出按序号分开的候选 JSON 和计数摘要，文件不含浏览器其他数据；仅通过 JSON 解析且结构校验的条目可候选恢复。损坏片段单独报告，禁止写回 LevelDB。不得把 savedAt 当每次日志写入时间。
- [x] 3. 新增 storage-db.js 并实现上述事务/迁移/快照契约；迁移异常能重试。新增 tests/storage.test.cjs 使用 fake-indexeddb 验证真实存储模块；测试依赖只用于开发，不进入扩展运行代码。
- [x] 4. background.js 接入统一命令处理；manager.html 加载存储相关入口，manager.js 移除所有收藏列表 chrome.storage.local.set/remove，改为命令调用。保留偏好持久化。增加 loading/ready/empty/error 明确状态，error 保留已有卡片并显示重试；empty 只能来自成功读取零条，显示 0 pages。
- [x] 5. 管理页添加轻量文本入口“回收站 / 导入 / 导出”，适配中英文。clear 二次确认并说明可从回收站找回；导入先显示候选数量、范围、重复数，用户确认后事务合并；导出 schemaVersion/scope/exportedAt/tabs。没有确认不得自动把历史日志恢复到收藏。
- [x] 6. 修正全部/单条恢复，统一保留收藏，展示成功、复用、失败计数和失败重试。新增 lazy-tab.js、移除内联脚本、连接页面激活消息。已有原始收藏与浏览器窗口不受测试影响。
- [ ] 7. 新增 package.json、锁文件和持久 tests：node:test、fake-indexeddb、Playwright 开发依赖。集成测试使用独立临时浏览器配置及本地测试网页。不得复用真实 Default 配置。测试入口详见下节。
- [x] 8. 验收后同步明确运行文件到 release/TabWall-v0.2.9（含新 JS 和 locales），比较哈希及 manifest 引用完整性。旧 ZIP 保持原样并在交接中明确它未更新。保存实施记录和测试结果。

## Validation

- [x] npm test → node --test tests/*.test.cjs：已通过迁移、重复运行时保护、两个并发 capture、reorder/trash/restore-trash、scope 隔离、导入校验和重启式重新打开数据库测试。
- [x] npm run test:integration → node --test tests/integration/*.test.cjs：已通过真实 background.js 消息入口、并发 capture、按 ID 恢复和 lazy-tab 激活测试；尚未替代真实 Edge UI 验收。
- [ ] 恢复测试：0/1/70 条、同 URL 多记录、已有普通页、已有延迟页、其他窗口同 URL、部分创建失败、连续点击、重试；成功次数与浏览器实际标签数相符，保存记录不减少；仅激活的目标加载本地网站。
- [ ] 重启测试：独立 profile 中收纳 70 条→关闭全部浏览器进程→用同 profile/扩展 ID 重开→70 条与顺序/偏好一致；重启后激活已恢复延迟页能加载。单独终止后台 worker 后再操作也成功。
- [ ] 若 Playwright 附带 Chromium 可加载扩展而本机 Edge 禁止自动旁加载，先完成 Chromium 测试，再使用独立 Edge 测试 profile 手工加载验证。不得把 Chromium 通过写成 Edge 通过。Edge 证据未完成则保持 in-progress，列明具体步骤。
- [x] node --check background.js / manager.js / storage-db.js / lazy-tab.js；JSON 校验；运行文件引用完整性检查已通过。真实 Edge 控制台仍需手工验收。

## Acceptance criteria

- [ ] 原安装路径和 ID 不改变；旧收藏键与历史证据保留；无真实用户数据被测试删除或覆盖。
- [ ] 数据保存成功仅在事务完成后显示；并发保存、排序、删除不丢其他记录；重启和 worker 重启后条目完整。
- [ ] 异常不显示 Empty；有内容与 Empty 互斥；跨页面更改能同步。
- [ ] 单条与全部恢复均打开浏览器且保留收藏，失败有明确统计并能重试；真实入口连接事务模块和后台。
- [ ] clear 确认后可恢复；历史候选 JSON 可经用户确认导入；历史提取失败需说明原因，不影响已有收藏。
- [ ] 页面保留纯图标视图切换与 SVG Hover、10–60 每行调节、pages 计数、日期/衰减/分组；不改版本号、不打包。
- [ ] 持久测试通过，含实际浏览器重启；验证结果和剩余限制写入 Execution notes。

## Risks and rollback

- 本次全空根因未确证，执行时对比当前 API、数据库候选和页面状态；不能把并发覆盖解释成已证明的重启原因。
- IndexedDB 迁移后旧版程序看不到新记录。回滚前先导出新库数据并保留原数据库，不仅覆盖旧 JS；旧 storage 键仅是迁移时间点快照。
- 隐私数据不得自动并入普通收藏、普通导出或恢复文件；明确分 scope。
- 记录可能包含敏感 URL；只保存在本地，不打印完整 URL 到常规测试输出，不上传。
- 不为测试重启真实浏览器。用户真实安装的最终验证只做只读检查，任何手工恢复都走导入预览确认。

## Execution notes

Luna 已开始执行。先完成数据证据保全，再迁移和替换运行链路。完成项目以前不得标记 complete。

### 2026-09-13 execution update

- IndexedDB `tabwall` 已接管收藏数据；旧 `tabwallSession` / `tabwallSessionPrivate` 只作为一次性迁移来源，旧键未删除。
- 已移除管理页上的回收站、JSON 导入/导出入口，恢复简洁核心 UI；clear 经二次确认后清除当前收藏，数据库仍保留内部快照用于故障保护。
- `release/TabWall-v0.2.9` 已与源码运行文件和中英文 locales 做 SHA256 对齐；没有改版本号，没有重新打包。
- 本地测试结果：`npm test` 2/2 通过；`npm run test:integration` 1/1 通过；四个脚本语法检查和 JSON 校验通过。
- 用户最新截图同时出现新管理页按钮、旧/缺失的新增翻译和统一存储错误，符合“管理页已刷新但旧 service worker/locale 仍在运行”的表现；因此新增错误提示会明确指导重新加载扩展。当前代码对 Bilibili、YouTube 等所有 `http/https` 视频 URL 均不做站点过滤，并已加入视频 URL 集成回归。
- 后续回归中发现管理页不停刷新的直接原因：`list` 读命令错误地广播 `storage-updated`，管理页再次 list 形成自循环。已加入红测并修复为仅写命令广播；读列表、读回收站和导出不会再触发刷新。
- 历史浏览器日志不再作为正式版运行时资源或自动恢复来源；如需找回旧数据，只能由用户通过明确的本地导入流程提供数据。
- 工具栏点击曾在关闭当前窗口网页标签后才打开管理页，并可能错误复用其他窗口的管理页，导致网页关闭后看不到 TabWall。已改为始终在点击所在窗口先创建/激活管理页，再关闭网页标签；新增 `tests/integration/action.test.cjs` 回归测试并同步 `release/TabWall-v0.2.9/background.js`。
- 2026-09-14：工具栏入口回归测试、`npm test` 和 `npm run test:integration` 全部通过；仍待独立 Edge profile 手工验收。
- 待完成：在独立 Edge profile 中手工执行“收集 → 完全退出 Edge → 重新打开 → 查看 0/多条记录、恢复延迟页”的真实验收。当前计算机自动化工具禁止直接操作 `extension://` 页面，因此本轮没有把该项标记为已通过，也没有触碰用户真实标签页做破坏性测试。
