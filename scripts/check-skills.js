/**
 * 一次性检查：ensoul 能不能真的看到用户技能库里的技能。
 * 用法： node scripts/check-skills.js [工作区目录]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
process.env.ENSOUL_WORKSPACE = path.resolve(process.argv[2] || 'D:\\WORK');

const stub = (id, exports) => {
  const file = require.resolve(id);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('electron', {
  app: { getAppPath: () => APP_DIR, getPath: (k) => (k === 'home' ? os.homedir() : path.join(APP_DIR, '.tmp')) },
});

const skills = require(path.join(APP_DIR, 'dist', 'main', 'skills.js'));

console.log(`工作区：${process.env.ENSOUL_WORKSPACE}\n`);
console.log('技能根（越靠前越优先）：');
for (const r of skills.skillRoots()) {
  console.log(`  ${fs.existsSync(r.path) ? '有' : '—'}  [${r.source}] ${r.path}`);
}
const list = skills.scanSkills([]);
console.log(`\n扫到 ${list.length} 个技能：`);
for (const s of list) {
  console.log(`  · ${s.name.padEnd(26)} ${String(s.bytes).padStart(7)}B  [${s.source}]  ${s.description.slice(0, 46)}`);
}
console.log('\n系统提示里会出现的摘要（只有名字和一句话）：');
console.log(skills.skillDigest([]).split('\n').map((l) => `  ${l}`).join('\n'));
