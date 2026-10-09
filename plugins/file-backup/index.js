/**
 * 写文件之前自动留底。
 *
 * 自我进化最怕的是"改坏了回不去"：一次 write_file 把文件写烂，原来那份就没了。
 * 面板有 revisions 能回退，源码文件什么都没有。这个插件挂在写文件之前，
 * 把旧内容存一份，并给出列备份 / 回滚两个工具。
 *
 * 备份放在应用数据根的项目分区 .ensoul/backups/ 下，按文件分槽：
 *   业务/前端/index.ts  ->  .ensoul/backups/业务__前端__index.ts/<时间戳>.bak
 */

const fs = require('fs');
const path = require('path');

/**
 * 可调参数（设置面板里能改，助手也能改 —— 见 plugins/plugin-kit）。
 *
 * "每个文件留几份"是件按项目定的事：源码项目想要更长的历史，跑一跑就丢的活少留点。
 */
const PARAMS = {
  keep: { label: t('每个文件最多留几份'), type: 'number', default: 40, min: 1, max: 500, hint: t('超了就删最旧的') },
};

module.exports = {
  params: PARAMS,
  name: 'file-backup',
  storage: { project: ['.ensoul/state/file-backup.json', '.ensoul/backups'] },
  description: t('写文件前自动备份旧内容，并提供 list_backups / restore_backup 两个工具'),

  setup(api) {
    const root = api.workspace;
    /** 留几份是参数（改了参数这个插件会重新 setup，所以 setup 时读一次就够） */
    const maxKeep = Math.max(1, Math.round(Number(api.param('keep')) || 40));
    const box = api.dataPath('.ensoul/backups');

    const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
    const slot = (rel) => path.join(box, String(rel || '').replace(/[\\/]/g, '__'));

    // 只在自己的地盘里动手：rel 里带 .. 就当作不存在
    const inside = (rel) => {
      const full = path.resolve(root, String(rel || ''));
      return full === root || full.startsWith(root + path.sep) ? full : null;
    };

    const listFor = (rel) => {
      try {
        return fs
          .readdirSync(slot(rel))
          .filter((f) => f.endsWith('.bak'))
          .sort()
          .reverse();
      } catch {
        return [];
      }
    };

    api.onBeforeWrite((rel, next) => {
      const full = inside(rel);
      if (!full) return;

      let old = null;
      try {
        old = fs.readFileSync(full, 'utf8');
      } catch {
        return; // 新文件，没有旧内容可留
      }
      if (old === next) return; // 内容没变，不必留

      const dir = slot(rel);
      const bakName = `${stamp()}.bak`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, bakName), old, 'utf8');
        const keep = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.bak'))
          .sort()
          .reverse();
        for (const f of keep.slice(maxKeep)) fs.unlinkSync(path.join(dir, f));

        // 记入全局操作日志 journal，供批量/紧急回滚
        try {
          const jPath = path.join(box, '_journal.json');
          let jList = [];
          if (fs.existsSync(jPath)) {
            try { jList = JSON.parse(fs.readFileSync(jPath, 'utf8')); } catch {}
          }
          jList.push({ rel, bak: bakName, time: Date.now() });
          if (jList.length > 80) jList = jList.slice(-80);
          fs.writeFileSync(jPath, JSON.stringify(jList, null, 2), 'utf8');
        } catch {}
      } catch (e) {
        api.log(t('备份失败：'), e && e.message); // 备份失败不能挡住写入本身
      }
    });

    api.addTool(
      {
        name: 'list_backups', kits: ['ops'],
        description: t('看某个文件留了几份历史备份（每次改它之前自动留的）'),
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      (args) => {
        const rel = String((args && args.path) || '');
        const items = listFor(rel);
        if (!items.length) return `${rel} 还没有备份。`;
        return `${rel} 的备份（新的在前）：\n${items.map((f) => `- ${f}`).join('\n')}`;
      },
    );

    api.addTool(
      {
        name: 'restore_backup', kits: ['ops'],
        description: t('把某个文件回滚到某一份备份；不传 backup 就回滚到最新的一份'),
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, backup: { type: 'string' } },
          required: ['path'],
        },
      },
      (args) => {
        const rel = String((args && args.path) || '');
        const full = inside(rel);
        if (!full) return `路径不在工作区里：${rel}`;

        const items = listFor(rel);
        if (!items.length) return `${rel} 没有备份，回滚不了。`;

        const pick = (args && args.backup && String(args.backup)) || items[0];
        if (!items.includes(pick)) return `没有这份备份：${pick}\n现有的：${items.join('、')}`;

        try {
          const text = fs.readFileSync(path.join(slot(rel), pick), 'utf8');
          api.files.write(rel, text);
          return `已把 ${rel} 回滚到 ${pick}（${text.length} 字符）。`;
        } catch (e) {
          return `回滚失败：${e && e.message}`;
        }
      },
    );

    api.addTool(
      {
        name: 'rollback_recent', kits: ['ops'],
        description: t('一键撤销最近几步对工作区文件的写入修改（批量回滚文件到修改前）。适用于多文件重构改乱或构建失败时一键复原。'),
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'number', description: t('撤销最近几步写入操作（默认 1，最多 20）') },
          },
        },
      },
      (args) => {
        const steps = Math.max(1, Math.min(20, Math.round(Number(args && args.steps) || 1)));
        const jPath = path.join(box, '_journal.json');
        if (!fs.existsSync(jPath)) return t('暂无写入历史流水，无法批量撤销。');
        let jList = [];
        try {
          jList = JSON.parse(fs.readFileSync(jPath, 'utf8'));
        } catch {
          return t('读取历史流水失败。');
        }
        if (!jList.length) return t('历史流水为空，无需撤销。');

        const toRollback = jList.slice(-steps).reverse();
        const rolled = [];
        const completed = new Set();
        const failed = [];

        for (const item of toRollback) {
          const full = inside(item.rel);
          if (!full) {
            failed.push(`${item.rel} (路径非法)`);
            continue;
          }
          const bakFile = path.join(slot(item.rel), item.bak);
          if (!fs.existsSync(bakFile)) {
            failed.push(`${item.rel} (备份文件缺失)`);
            continue;
          }
          try {
            const text = fs.readFileSync(bakFile, 'utf8');
            api.files.write(item.rel, text);
            rolled.push(item.rel);
            completed.add(item);
          } catch (e) {
            failed.push(`${item.rel} (${e && e.message})`);
          }
        }

        jList = jList.filter((item) => !completed.has(item));
        try {
          fs.writeFileSync(jPath, JSON.stringify(jList, null, 2), 'utf8');
        } catch {}

        return [
          `已恢复 ${rolled.length} 项，未恢复 ${failed.length} 项：`,
          ...rolled.map((f) => `✔ 恢复：${f}`),
          ...failed.map((f) => `✖ 失败：${f}`),
        ].join('\n');
      },
    );
  },
};
