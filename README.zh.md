[English](./README.md) · [中文](./README.zh.md)

# 德州扑克 ♠

浏览器中的实时多人德州扑克。无需注册，分享 6 位房间码即可开始游戏。

## 功能

- 每局最多 9 名玩家，支持观战
- 完整规则：盲注、边池、全押、操作倒计时、断线重连保护
- 可配置买入上限，筹码耗尽可随时再次买入
- 双语界面 —— 中文（`GAME_LANG=zh`）或英文（默认）
- **PWA** —— 可安装至 iOS / Android 主屏，首次加载后支持离线使用

## Docker Compose

```yaml
services:
  texas-holdem:
    build: .
    ports:
      - "3448:3448"
    environment:
      - PORT=3448
      - GAME_LANG=zh   # zh | en（默认）
    restart: unless-stopped
```

```bash
docker compose up -d
# 访问 http://localhost:3448
```

## 本地运行

```bash
npm install
GAME_LANG=zh node server.js  # 中文
node server.js               # 英文
```

## PWA 安装

移动端：点击浏览器 **分享 → 添加到主屏幕**（iOS），或浏览器安装提示（Android/Chrome）。

## 技术栈

Node.js · Express · Socket.IO · 原生 JS（无框架）
