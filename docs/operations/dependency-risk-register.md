# 开发工具链依赖风险登记

## 2026-08-25：drizzle-kit 间接 esbuild 漏洞

- 状态：接受延期；2026-09-25 前复核，或在上游发布兼容修复后立即复核。
- 严重度：4 个 moderate，来源为开发依赖 `drizzle-kit@0.31.10 -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild@0.18.20`。
- 公告：GHSA-67mh-4wv8-2f99，影响暴露到网络的 esbuild 开发服务器读取响应。
- 可达性：该链只用于迁移/生成开发工具，不进入 Web/Worker 运行镜像入口；生产环境不得启动 drizzle-kit 或 esbuild 开发服务器，也不得暴露其端口。
- 当前 npm 自动修复建议：回退 `drizzle-kit` 到 `0.18.1`。这是破坏性回退，会改变迁移工具契约，不能在发布候选上盲目采用。
- 现有新版：`drizzle-kit@0.31.10` 仍直接依赖旧 `@esbuild-kit/esm-loader`；单独 override 深层 esbuild 未获上游兼容保证。
- 门禁：critical/high 依赖漏洞阻断 CI；moderate 允许在本登记有效期内通过，但每周 Dependabot 继续检测。生产容器不得执行或暴露 drizzle-kit/esbuild 开发服务器。

解除延期必须满足：上游兼容版本、`npm audit` 结果清零或公告不再命中，并通过迁移生成 diff、全新库全部迁移、serial integration、E2E 和 production build。
