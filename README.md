# gitflow

自动检测 **Vite + React/Vue + TypeScript** 前端项目架构，交互式生成 GitHub Actions 部署工作流（腾讯云 COS）与 sitemap 自动生成脚本。

## 安装

### 方式一：npm 全局安装

```powershell
npm install -g 路径\gitflow\

执行 gitflow 即可
```

### 方式二：直接运行（无需安装）

```powershell
# 克隆本仓库后
node tools/gitflow/bin/cli.mjs
```

## 用法

### 独立 Vite 项目

```powershell
cd my-vite-project
gitflow
```

### pnpm workspace 下的 Vite 子项目

在 **子项目目录** 下运行（工具会自动向上查找 `pnpm-workspace.yaml`）：

```powershell
cd my-monorepo/apps/web
gitflow
```

生成结果（均写入 **当前 Vite 子项目根目录**）：
- `.github/workflows/deploy-cos.yml`
- `scripts/generate-sitemap.mjs`

工作流根据子项目包管理器分两种模式：

- **npm 子项目**：若缺少 `package-lock.json`，CI 会先根据 `package.json` 自动生成，再启用 npm 缓存并执行 `npm ci`；自动识别仓库是完整 monorepo 还是仅含子项目本身，避免 `apps/xxx` 路径不存在
- **pnpm 子项目**：在 workspace 根目录 `pnpm install --frozen-lockfile`，通过 `pnpm --filter` 构建

## 交互流程

```
╔══════════════════════════════════════════╗
║   🚀 gitflow  v1.0.0                    ║
║   前端项目 CI/CD 工作流生成器            ║
╚══════════════════════════════════════════╝

🔍 项目检测结果:
   框架:       React
   打包器:     Vite
   语言:       TypeScript
   路由候选:   src/routes.tsx

📝 请配置部署工作流:

? 路由文件路径 (src/routes.tsx):
? 部署分支 (master):
? 站点域名（不含协议）: www.example.com
? Node.js 版本 (24):
? Python 版本 (3.11):
? pnpm 版本 (9):                    # workspace 根目录安装依赖
? 子项目包管理器 npm/pnpm (npm):    # 自动检测，可手动选择
? 构建命令 (npm run build):         # npm 子项目默认
# 或
? 构建命令 (pnpm --filter @app/web build):  # pnpm 子项目默认

✅ 文件生成完毕:
   📄 .github/workflows/deploy-cos.yml
   📄 scripts/generate-sitemap.mjs
```

## 生成的文件

### `.github/workflows/deploy-cos.yml`

触发条件：推送至指定分支 + 手动触发。

工作流步骤：
1. Checkout 代码
2. 安装 pnpm 与 Node.js（pnpm 项目启用依赖缓存）
3. 在 workspace 根目录安装依赖（`pnpm install --frozen-lockfile`）
4. 通过 `pnpm --filter` 构建目标 Vite 子项目
5. 调用子项目的 `scripts/generate-sitemap.mjs` 生成 sitemap.xml 与 robots.txt
6. 安装 coscmd 并上传至腾讯云 COS

### `scripts/generate-sitemap.mjs`

- 从用户指定的路由文件中**动态解析**所有路由路径
- 自动生成 `sitemap.xml` + `robots.txt`
- SEO 配置（priority / changefreq）可在脚本内 `SEO_CONFIG` 对象中修改
- 支持 React Router (`export const routes`) 与 Vue Router (`routes: [...]`) 两种写法
- 自动排除通配路由（`*`、`/*`、带 `:` 的动态路由）

### 站点域名优先级

sitemap / robots.txt 中的域名按以下顺序解析：

1. **gitflow 交互输入的域名**（写入 workflow，优先级最高）
2. **GitHub Secret `SITE_URL`**（用户未输入域名时使用）
3. **`www.仓库名.com`**（以上均未配置时的回退，仓库名来自 `github.event.repository.name`）

## GitHub Secrets 配置

部署前需在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加以下内容：

| Secret | 说明 |
|--------|------|
| `SITE_URL` | （可选）站点域名；已在 gitflow 中配置域名时可省略 |
| `COS_SECRET_ID` | 腾讯云 SecretId |
| `COS_SECRET_KEY` | 腾讯云 SecretKey |
| `COS_BUCKET` | COS 存储桶名称 |
| `COS_REGION` | COS 地域，如 `ap-guangzhou` |
| `COS_TARGET_PATH` | （可选）上传路径，默认 `/Default/` |

## 技术架构

```
gitflow/
├── bin/cli.mjs                       # CLI 入口
├── src/
│   ├── detect.mjs                    # 自动检测框架/打包器/语言/路由
│   ├── prompts.mjs                   # 交互式问答（零依赖 readline）
│   ├── generate-workflow.mjs         # 生成 deploy-cos.yml
│   └── generate-sitemap-script.mjs   # 生成 scripts/generate-sitemap.mjs
└── package.json
```

## License

MIT
