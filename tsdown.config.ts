import { defineConfig } from 'tsdown'

/**
 * tsdown 只做转译与打包，不做类型检查（类型检查由 `pnpm typecheck` 负责）。
 * prepare 脚本在 git 安装后由 pnpm 执行，因此构建必须自包含、不依赖 monorepo。
 * fixedExtension: false —— 包声明 "type": "module"，保持 .js/.d.ts 扩展名，
 * 与 package.json 的 exports 映射一致。
 */
const lib = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  fixedExtension: false,
}

/**
 * Client 半边：浏览器 bundle，交给 dsh 的 client-modules 分发。
 * 产物必须是 __ModuleLoader__.load 握手格式（banner/footer），并以 CJS 输出
 * （工厂通过注入的 require 从浏览器模块表解析 externals）。
 * externals 只允许浏览器平台模块表里有的包；react 是唯一运行时外部依赖，
 * 其余依赖一律内联（noExternal），防止 require 到模块表回答不了的 specifier。
 * react/jsx-runtime 由 jsx: react-jsx 自动引入，一并列出。
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'zod']
const client = {
  name: 'dsh-plugin-zn-agent-client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    // 固定产物名 lib/client.js，与 package.json exports["./client"] 对应。
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-zn-agent-client", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([lib, client])