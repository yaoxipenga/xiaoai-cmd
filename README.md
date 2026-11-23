# 小爱文字指令 · Songloft 插件源

在页面输入一句文字，让小爱音箱**像听到这句话一样执行指令**——不用喊「小爱同学」、不用麦克风，也不怕音箱正大声放着歌。

> 例：在控制栏输入「接听电话」，对面音箱直接执行；输入「暂停播放」「关闭客厅灯」「音量调到 20」同理。

---

## 提交到插件源的地址

把这个 URL 填进 Songloft「设置 → 导航与插件 → 提交插件源」即可：

```
https://raw.githubusercontent.com/yaoxipenga/xiaoai-cmd/main/registry.json
```

> 若你的 GitHub 用户名不是 `yaoxipenga`，或换了仓库名，先运行一次 `publish.ps1 -GitHubUser 你的用户名`（会自动替换全部 URL 并重算哈希），再把脚本输出的 URL 填进表单。

---

## 发布（只需一次）

1. 在 GitHub 新建一个**公开、空**仓库，例如 `xiaoai-cmd`（不要勾选 README / .gitignore / License 初始化）。
2. 在本目录执行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\publish.ps1 -GitHubUser 你的用户名
   ```

   脚本会替换仓库地址、重算 `entryHash` / `zipHash`、重新打包 zip、`git init` + `commit` + `push` 到 `main`。
   若本机已登录 GitHub，也可直接手动推送：

   ```bash
   git init && git add . && git commit -m "init plugin registry"
   git branch -M main
   git remote add origin https://github.com/<用户名>/xiaoai-cmd.git
   git push -u origin main
   ```

3. 打开上面那个 `registry.json` 的 raw 地址确认能访问，然后把 URL 提交到插件源表单。

ZIP 通过仓库内 raw 地址分发（`download_url` 指向仓库根目录的 `.jsplugin.zip`），因此 **push 完立刻可安装**，不需要额外创建 Release。若以后想改用 GitHub Releases，把 `plugin.json` / `manifest.json` 的 `download_url` 换成 Release Asset 地址并重新运行 `build.py` 即可。

---

## 为什么可以「打开即用、不用再登录」

Songloft 的 `songloft.storage` 按插件隔离，插件之间读不到彼此的账号；但插件可以调用宿主**「智能音箱」插件**的 HTTP 路由：

| 能力 | 通道 | 是否需要额外登录 |
| --- | --- | --- |
| 设备列表（所有音箱） | `/api/v1/jsplugin/miot/mina/devices` | 否 |
| 执行前停止播放 / 调音量 / 播报 | `/api/v1/jsplugin/miot/mina/*` | 否 |
| 云端文本指令所需的小米账号凭据 | 本机读取 `jsplugins_data/miot/data/accounts` | 否，自动复用 |

每次下发指令都会**重新读取**该账号文件，因此官方插件自动刷新 `serviceToken` 后，本插件无需任何操作即可继续工作。

> 读取范围仅限本机 Songloft 数据目录下「智能音箱」插件自己的账号文件；凭据只保存在本机、只用于调用小米云 API，不会上传到任何第三方服务器。这也是 `plugin.json` 声明 `command` 权限的唯一用途（调用 `songloft.command.exec` 读取本机文件）。
> 若宿主限制了文件读取，插件会提示「自动复用未生效」，此时可在页面「高级设置」里粘贴一次同一个账号文件，功能不受影响。

## 指令执行通道

1. **MIoT `5-4` execute-text-directive**（主）：官方 MIoT 动作，`siid=5, aiid=4`，参数 `[文本, 是否静默]`，效果等同直接对小爱说出这句话。需要 `xiaomiio` 的 `serviceToken` + `ssecurity` 与设备 `miotDID`。
2. **云端 `mibrain / ai_service`**（备）：`POST https://api2.mina.mi.com/remote/ubus`，`message = {tts:1, nlp:1, nlp_text:"…"}`。需要 `micoapi` 的 `serviceToken`。
3. **宿主控制通道**（兜底）：停止播放、降低音量、TTS 播报，零凭据即可用。

两条云端通道都会把 HTTP 状态与云端返回码逐条写入页面的黑色执行日志，便于判断是凭据问题还是机型固件不支持。

> 「远程呼唤」的文字模式用的是 `mibrain/text_to_speech`，只是**朗读**文本；本插件用的是**执行**文本指令，两者不是一回事。

## 已知限制

- 不同机型 / 固件对文本指令动作的开放程度不一致，老款（如小爱音箱 mini）可能返回非 0 错误码。
- 「接听 / 挂断电话」还要求音箱本身已绑定通话功能。
- 若两条云端通道都被拒，可勾选「执行前停止播放」并用「仅播报」提示，或在米家 App 里建立手动场景用小爱口令触发。

## 更新插件

改完 `main.js` / `static/index.html` 后：把 `plugin.json` 与 `manifest.json` 的 `version` 改成新版本号，运行 `python build.py`（重算哈希并重新打包），然后 `git add . && git commit && git push`。商店会按版本号提示更新。

## 目录结构

```
xiaoai-cmd/
├── registry.json          ← 插件源（表单要的 URL）
├── plugin.json            ← 插件元数据 + 双层哈希
├── manifest.json          ← 更新检查清单
├── xiaoai-text-command.jsplugin.zip  ← 可下载的安装包
├── main.js                ← 插件后端源码
├── static/index.html      ← 控制栏页面
├── static/icon.svg        ← 图标（GitHub 发现页读取）
├── build.py               ← 重算哈希 + 打包
├── publish.ps1            ← 一键替换地址并推送
└── README.md
```
