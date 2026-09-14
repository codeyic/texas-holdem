# 局域网德州扑克

朋友娱乐局：昵称进房、房间号 / 二维码、固定盲注筹码桌。仅供娱乐，不涉及真实货币。

源码目录：`texas-holdem/`（本仓库内）。对外访问路径：`/poker/`。

## 环境

- Node.js 18 及以上
- 现代浏览器（Chrome / Safari / Edge 近两年版本）

## 本地开发

```bash
cd texas-holdem
npm install
npm test
npm run dev
```

浏览器打开 `http://127.0.0.1:5173/poker/`。服务端在 `8080`，Vite 会把 `/poker/api` 和 `/poker/ws` 代理过去。

## 生产启动（局域网或服务器）

```bash
cd texas-holdem
npm install
npm test
npm run build
npm start
```

默认监听 `0.0.0.0:8080`。页面地址：

- 本机：`http://127.0.0.1:8080/poker/`
- 局域网：`http://电脑IP:8080/poker/`
- 域名：`https://codeyc.top/poker/`

可用环境变量改端口：`PORT=8080 npm start`。

## 挂到 https://codeyc.top/poker/

1. 在服务器上进入本目录，执行 `npm run build && npm start`（建议用 systemd / pm2 守护）。
2. Nginx 只反代 `/poker/` 到 `127.0.0.1:8080`，**不要**把整站根路径指过来。示例见 [deploy/nginx.conf.example](deploy/nginx.conf.example)。
3. `proxy_pass` 不要写成带尾斜杠的 `http://127.0.0.1:8080/`，否则会把 `/poker` 前缀剥掉。

## 玩法摘要

- 2～8 人，买入 1000 筹码
- 开房时可选手盲/大盲：5/10、10/20、25/50
- 房主满 2 人可开始；一手结束后自动开下一手
- 行动限时约 20 秒：可过则过，否则弃牌
- 破产后可在非下注阶段再买入
- AI 人机补位：房主在设置菜单可添加 6 档性格 AI（紧凶/松凶/紧弱/跟注站/疯狂/岩石，按添加顺序循环），基于起手牌范围 + 胜率 + EV 自动决策
- 实时胜率：自己座位实时显示当前胜率（服务端蒙特卡洛计算）
- 打法复盘：每手牌自动生成逐决策点复盘（实际 vs 推荐动作、EV 差、损失 BB、漏洞标签），IndexedDB 本地保存，设置菜单「复盘」查看
- 长期统计：按街与漏洞类型聚合的历史统计视图，设置菜单「统计」查看

## 校验

```bash
npm test
npm run build
```
