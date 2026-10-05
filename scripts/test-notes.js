// 回归测试：拿假 api 跑 plugins/notes，验证配对抓取 / 补齐 / 上限 / 迁移
const path = require('path');
const plugin = require(path.join(__dirname, '..', 'plugins', 'notes', 'index.js'));

let fails = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}${ok ? '' : '   <<< ' + (extra ?? '')}`);
  if (!ok) fails++;
};

function boot(panels, saved) {
  const box = { value: saved ?? null, writes: 0, prompts: [] };
  const api = {
    panels: () => panels,
    addPrompt: (fn) => box.prompts.push(fn),
    addStatusItem: () => {},
    state: {
      load: () => box.value,
      save: (v) => {
        box.value = JSON.parse(JSON.stringify(v));
        box.writes++;
      },
    },
    log: () => {},
  };
  plugin.setup(api);
  plugin.dispose();
  return box;
}
const marks = (box, id) => (box.value.panels[id] || []).map((n) => n.marks);

// ---- 1. 一条便签 = 我说的那句 + 紧接着那轮回答里的 ==…==
const u1 = '把便签搬到插件里去。顺便清一下死代码';
const a1 = '好，就按这个来：==便签住 plugins/notes== 然后 ==它自己存状态== 就这样';
let box = boot([
  {
    id: 'p1',
    chat: [
      { role: 'user', content: u1 },
      { role: 'assistant', content: a1 },
      { role: 'tool', content: '==工具里的不收==' },
    ],
  },
]);
let list = box.value.panels.p1;
check('用户那句成了便签的标题（在句号处截断）', list.length === 1 && list[0].text === '把便签搬到插件里去', JSON.stringify(list));
check('紧接着那轮回答里的两条标记挂在它下面', JSON.stringify(list[0].marks) === '["便签住 plugins/notes","它自己存状态"]', JSON.stringify(marks(box, 'p1')));
check('tool 消息里的 ==…== 不收', !JSON.stringify(list).includes('工具里的不收'));
check('落盘了状态文件', box.writes > 0);

// ---- 2. 重复扫不重复记
box = boot([{ id: 'p1', chat: [{ role: 'user', content: u1 }, { role: 'assistant', content: a1 }] }], box.value);
check('再扫一遍不会重复记', box.value.panels.p1.length === 1 && box.value.panels.p1[0].marks.length === 2, JSON.stringify(box.value.panels.p1));

// ---- 3. 回答是逐字到达的：先看见半截，后面补上
box = boot([{ id: 'p1', chat: [{ role: 'user', content: u1 }, { role: 'assistant', content: '好，就按这个来：==便签住 plugins/notes==' }] }]);
check('先到的半截先记下（1 条标记）', box.value.panels.p1[0].marks.length === 1, JSON.stringify(box.value.panels.p1[0]));
box = boot([{ id: 'p1', chat: [{ role: 'user', content: u1 }, { role: 'assistant', content: a1 }] }], box.value);
check('后半段到了就补进同一条，不新增便签', box.value.panels.p1.length === 1 && box.value.panels.p1[0].marks.length === 2, JSON.stringify(box.value.panels.p1));

// ---- 4. 我说下一句之后，标记归下一条
box = boot([
  {
    id: 'p2',
    chat: [
      { role: 'user', content: '先挪便签' },
      { role: 'assistant', content: '==便签挪完了==' },
      { role: 'user', content: '再挪番茄钟' },
      { role: 'assistant', content: '==番茄钟也挪完了==' },
    ],
  },
]);
check('标记各归各的那一句', JSON.stringify(marks(box, 'p2')) === '[["便签挪完了"],["番茄钟也挪完了"]]', JSON.stringify(marks(box, 'p2')));

// ---- 5. 我说的话之前圈的东西没有主，不收（那是它自己的进度汇报）
box = boot([
  { id: 'p3', chat: [{ role: 'assistant', content: '==我先汇报一下进度==' }, { role: 'user', content: '继续' }] },
]);
check('没有主的那条进度不收', !JSON.stringify(box.value).includes('我先汇报一下进度'), JSON.stringify(box.value));

// ---- 6. 太长的用户消息不记，这一轮的标记也就不收
box = boot([
  { id: 'p4', chat: [{ role: 'user', content: '这'.repeat(200) }, { role: 'assistant', content: '==太长不问==' }] },
]);
check('没有便签的面板不占槽位', Object.keys((box.value || { panels: {} }).panels).length === 0, JSON.stringify(box.value));

// ---- 7. 每个面板最多 40 条，留下的是最新的
const many = [];
for (let i = 0; i < 45; i++) many.push({ role: 'user', content: `第 ${i} 件事` }, { role: 'assistant', content: `==第 ${i} 条==` });
box = boot([{ id: 'p5', chat: many }]);
list = box.value.panels.p5;
check('一个面板最多 40 条', list.length === 40, String(list.length));
check('砍掉的是最旧的', list[0].text === '第 5 件事' && list[39].text === '第 44 件事', list[0].text + ' ... ' + list[39].text);

// ---- 8. 一条便签最多挂 6 条标记
const noisy = Array.from({ length: 10 }, (_, i) => `==第 ${i} 条==`).join(' ');
box = boot([{ id: 'p6', chat: [{ role: 'user', content: '这条问答很啰嗦' }, { role: 'assistant', content: noisy }] }]);
check('一条便签最多挂 6 条标记', box.value.panels.p6[0].marks.length === 6, String(box.value.panels.p6[0].marks.length));

// ---- 9. 头一回跑：核心存的旧便签（扁平）迁成新结构
box = boot([
  {
    id: 'p7',
    chat: [],
    notes: [
      { at: 1, from: 'user', text: '旧的一句话' },
      { at: 2, from: 'assistant', text: '旧的一条要点' },
      { at: 3, from: 'user', text: '旧的另一句话' },
      { at: 4, from: 'assistant', text: '旧的另一条要点' },
    ],
  },
]);
list = box.value.panels.p7;
check('旧便签按"话 + 它下面的要点"搬过来', list.length === 2 && list[0].text === '旧的一句话' && list[0].marks[0] === '旧的一条要点', JSON.stringify(list));

// ---- 9b. 已经跑过的老 state（扁平那种）也要就地迁过来
box = boot([{ id: 'p7', chat: [] }], {
  panels: {
    p7: [
      { at: 1, from: 'user', text: '旧的一句话' },
      { at: 2, from: 'assistant', text: '旧的一条要点' },
    ],
    pX: [{ at: 3, from: 'assistant', text: '没有主的进度' }],
  },
});
check('老 state 就地迁成新结构', box.value.panels.p7[0].text === '旧的一句话' && box.value.panels.p7[0].marks[0] === '旧的一条要点', JSON.stringify(box.value.panels.p7));
check('只剩它自己进度的面板被清掉', !box.value.panels.pX, JSON.stringify(box.value.panels));

// ---- 10. 长文本各截到 120 字
box = boot([
  {
    id: 'p8',
    chat: [{ role: 'user', content: '短话' }, { role: 'assistant', content: '==' + '长'.repeat(180) + '==' }],
  },
]);
check('一条标记截到 120 字', box.value.panels.p8[0].marks[0].length === 120, String(box.value.panels.p8[0].marks[0].length));

// ---- 11. 坏面板不许炸
box = boot([null, { id: 'p9' }, { id: 'p10', chat: [{ role: 'user', content: '帮我把这个拆开' }] }]);
check('坏面板不影响别的面板', box.value.panels.p10 && box.value.panels.p10.length === 1, JSON.stringify(box.value.panels));

// ---- 12. 提示词讲清了"圈针对他这句话的事"
box = boot([{ id: 'p11', chat: [] }]);
const prompt = box.prompts.map((f) => f()).join('\n');
check('提示词说了标记归紧接着那轮', /紧接着这一轮回答/.test(prompt), prompt.slice(0, 80));
check('提示词说了不要圈自己的进度汇报', /进度汇报/.test(prompt));

console.log(fails ? `\n${fails} 项没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
