# DSH 桌面端（专属壳）v1.1.0

DeepSeek Harness 的桌面客户端：标准 Windows 窗口 + 系统托盘，窗口内就是 DSH Web 界面
（http://127.0.0.1:3080），数据与会话与浏览器端完全共享（都在 `~/.dsh`）。

## 功能

- **一键启动**：检测 3080 端口 → 无服务则后台拉起 `dsh web --no-open` → 就绪后开窗
  （`--no-open` 保证**不会**额外唤起默认浏览器，桌面壳自己就是窗口）
- **独立窗口**：标准窗口，记忆位置/大小（带屏幕越界保护），鲸鱼娘图标
- **系统托盘**：关闭按钮 = 最小化到托盘；托盘菜单（文字居中、带图标列）：
  - **重启 DSH** —— 校验 3080 上是 DSH 服务后停旧进程、拉起新服务、窗口自动重连
  - **开机自启动** —— 开启后选项前显示绿色勾
  - **退出 DSH** —— 真正退出：停掉 DSH 服务进程、释放 3080 端口、关闭桌面壳
- **单实例**：重复双击只会调出已有窗口
- **服务健康看护**：dsh web 意外退出/被重启后，窗口自动重新连接，无需手工刷新
- **端口身份校验**：只认注入 `__DSH_BOOT__` 的真 DSH 服务——不会误加载其他程序的
  3080 端口，也不会在“重启/退出”时误杀无关进程
- **日志**：`%LOCALAPPDATA%\dsh-desktop.log`（服务输出 + 事件日志，超 2MB 自动轮转）

## 使用

打包产物在 `dist\`：**双击 `DSH桌面端-1.1.0.exe`** 即用（便携版，无需安装）。

## 开发

```powershell
npm install          # 安装依赖（electron / electron-builder）
npm start            # 开发模式运行
npm run dist         # 打包便携版 exe（产物在 dist\）
```

> 国内网络打包前建议设置镜像（electron/构建工具走 GitHub 直连容易超时）：
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```

## 结构

- `main.js` —— 主进程（单实例 / 服务管理 / 窗口 / 托盘 / 自启 / 退出 / 健康看护）
- `preload.js` —— 安全桥（仅暴露「重试」通道给错误页）
- `error.html` —— 服务异常时的错误页（带重试按钮）
- `icon.ico` —— 鲸鱼娘图标（源自 图标素材\WhaleGirl.ico）
- `check.png` / `blank.png` —— 托盘菜单图标（绿色勾 / 透明占位）

## 变更记录

### v1.1.0
- **修复**：启动/重启桌面端不再自动唤起默认浏览器（`dsh web` 默认会打开浏览器，
  桌面壳拉起服务时显式加 `--no-open`）
- **修复**：托盘“重启”时先确认旧进程退出再启动新服务，避免 EADDRINUSE 双启动
- **修复**：重启/退出前校验 3080 端口身份，避免误杀其他程序
- **稳定性**：新增服务健康看护，dsh web 宕机恢复后窗口自动重连
- **稳定性**：窗口位置存档增加屏幕越界保护；退出时正确收尾日志流
- **兼容**：适配 dsh 0.1.1（CLI 与端口行为不变，可直接运行新版）

## 开源协议

MIT（见 [LICENSE](LICENSE)）。
