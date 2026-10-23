# GitHub Proxy · Cloudflare Workers

部署在 Cloudflare 边缘的 GitHub **公开资源**代理，无运行时依赖，无需 KV、R2 或数据库。响应直接流式转发，不把整个文件读入内存。

在线实例：<https://fastgit.hns.cool>（备用地址：<https://githubproxy.qixingyue.workers.dev>）

## 部署

需要 Node.js 22+、npm 和 Cloudflare 账号：

```sh
npm ci
npm test
npm run check
npx wrangler login
npm run deploy
```

部署后会输出 `https://githubproxy.<你的子域>.workers.dev`。Worker 名称可在 `wrangler.jsonc` 的 `name` 中修改；也可以在 Cloudflare 控制台的 Worker → Settings → Domains & Routes 中绑定自己的域名。代码不绑定固定代理域名。

本地运行：

```sh
npm run dev
```

打开 `http://localhost:8787`，粘贴资源链接即可获取。若本机访问 GitHub 或 npm 不通，可先设置自己的网络代理。

## 使用

把代理地址加在完整 HTTPS GitHub URL 前面：

```text
https://gh.example.com/https://github.com/OWNER/REPO/releases/download/TAG/FILE
https://gh.example.com/https://github.com/OWNER/REPO/archive/refs/heads/main.zip
https://gh.example.com/https://raw.githubusercontent.com/OWNER/REPO/main/FILE
https://gh.example.com/https://api.github.com/repos/OWNER/REPO/releases/latest
```

`github.com/OWNER/REPO/blob/...` 会转换成文件下载路径。原始查询参数会保留；也支持 `/?url=<经 URL 编码的完整资源链接>`，首页表单使用这种方式。

```sh
# Release 下载，保留上游文件名
curl -fLJO 'https://gh.example.com/https://github.com/OWNER/REPO/releases/download/TAG/FILE'

# 断点续传（需要上游支持 Range）
curl -fL -C - -o FILE 'https://gh.example.com/https://github.com/OWNER/REPO/releases/download/TAG/FILE'

# 公开仓库 HTTPS clone；后续 fetch / pull 使用相同代理 remote
git clone 'https://gh.example.com/https://github.com/OWNER/REPO.git'

# 将现有仓库的 origin 切换到代理
git remote set-url origin 'https://gh.example.com/https://github.com/OWNER/REPO.git'
```

不要为整个系统设置 Git `insteadOf`：本代理不支持 push。需要推送时，可单独配置原始推送地址：

```sh
git remote set-url --push origin 'https://github.com/OWNER/REPO.git'
```

## 行为与限制

- 支持 GET、HEAD、浏览器 CORS，以及仅用于 Git clone/fetch 的 upload-pack POST；禁止 push 和其他 POST。
- 精确允许的域名在 `src/index.js` 的 `HOSTS` 中：GitHub、Raw、Codeload、API、Gist、Release assets、Objects、用户图片和头像；每次上游重定向都重新校验 HTTPS 和域名，最多跟随 5 次。拒绝带账号密码或非默认端口的目标。
- 只转发获取资源所需的请求头，不转发 Cookie、Authorization、Referer 或自定义凭据；不支持私有仓库、SSH、Git LFS 完整流程、GitHub 登录或完整网页镜像。子模块地址不会被改写，需要单独配置。
- 保留上游状态码、文件名、ETag、Last-Modified、Range、Content-Range 和速率限制头。GitHub 错误和限流不会被伪装成成功。
- 向上游固定请求 `Accept-Encoding: identity`，保证完整下载与分段续传的字节偏移一致；这是 HTTP 传输编码设置，不会解压 ZIP、tar.gz 等文件本身。
- 不强制缓存或覆盖上游缓存时长，沿用 `fetch` 的 Cloudflare 缓存规则与上游缓存头；分支、latest 和 API 不承诺固定时间缓存。没有复制大文件到 Cache API，避免缓冲大响应。
- 删除响应 Cookie，使用 CSP sandbox 禁止上游 HTML / SVG 在代理域名下执行脚本；代理用途是获取文件，页面展示可能受限。
- 未内置身份验证或限流，默认是公开服务。公开分享后其他人可消耗 Worker 配额，建议按实际需要在 Cloudflare 配置访问控制与限流；GitHub 上游限流仍然适用。
- 是否提速取决于用户到 Cloudflare 以及 Cloudflare 到 GitHub 的链路；`workers.dev` 在部分网络不可用时，需要可访问的自定义域名。流式转发避免整文件占用内存，但仍受 Cloudflare 套餐、请求大小等平台限制约束。

## 验证

`npm test` 使用 Node.js 自带测试运行器，覆盖目标校验、重定向、流式响应、Range、凭据隔离、Git POST、HEAD、条件请求和错误状态。`npm run check` 由 Wrangler 打包并校验部署配置，不上传、不创建线上资源。

部署后建议用实际域名验证一次 Raw、Release、`curl -C -` 和 `git clone --depth=1`，并对比直连速度。本地 mock 测试不代表真实边缘链路可用性或性能。

参考：[Cloudflare Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)、[Fetch / Request 重定向](https://developers.cloudflare.com/workers/runtime-apis/request/)、[缓存行为](https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/)、[平台限制](https://developers.cloudflare.com/workers/platform/limits/)。
