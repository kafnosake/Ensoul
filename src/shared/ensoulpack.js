/**
 * 插件这一侧的薄壳 —— 插件是**外来的 CJS**，不 build 就拿不到 TypeScript。
 *
 * 真正的实现只有一份：src/shared/ensoulpack.ts（要被主进程按类型引用）。
 * 这里转一手构建产物 —— 插件永远跑在已经构建起来的进程里（app 读的是 dist），
 * 所以这条路一定存在；缺了就是没构建，那连软件都起不来。
 */
module.exports = require('../../dist/shared/ensoulpack.js');
