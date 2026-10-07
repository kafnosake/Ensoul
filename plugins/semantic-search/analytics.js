function vector(value) {
  if (!Array.isArray(value) || !value.length || !value.every(Number.isFinite)) throw new Error('模型返回了无效向量');
  const norm = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));
  if (!norm) throw new Error('模型返回了零向量');
  return value.map(n => n / norm);
}

function cosine(a, b) {
  if (a.length !== b.length) throw new Error('向量维度不一致');
  return a.reduce((sum, n, i) => sum + n * b[i], 0);
}

function steer(inputs, task) {
  return inputs.map(item => item.text && !item.image && !item.audio && !item.video
    ? { text: `task: ${task} | query: ${item.text}` } : item);
}

async function similarity(runtime, inputs, signal) {
  const values = (await runtime.encode(steer(inputs, 'sentence similarity'), { signal })).map(vector);
  return { matrix: values.map(a => values.map(b => cosine(a, b))) };
}

async function classify(runtime, inputs, labels, signal) {
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 50 || labels.some(x => typeof x !== 'string' || !x.trim())) throw new Error('请提供 2–50 个非空类别名称');
  const values = (await runtime.encode(steer(inputs, 'classification'), { signal })).map(vector);
  const categories = (await runtime.encode(labels.map(text => ({ text: `task: classification | query: ${text}` })), { signal })).map(vector);
  return { results: values.map((v, index) => {
    const scores = categories.map((c, i) => ({ label: labels[i], score: cosine(v, c) })).sort((a, b) => b.score - a.score);
    return { index, label: scores[0].label, scores };
  }), scoreMeaning: '相似度，不是分类概率' };
}

async function cluster(runtime, inputs, count, signal) {
  if (!Number.isInteger(count) || count < 2 || count > Math.min(20, inputs.length)) throw new Error('分组数应为 2–20，且不能超过内容数量');
  const values = (await runtime.encode(steer(inputs, 'clustering'), { signal })).map(vector);
  const centers = [values[0]];
  while (centers.length < count) {
    const selected = values.map((v, i) => ({ i, distance: 1 - Math.max(...centers.map(c => cosine(v, c))) })).sort((a, b) => b.distance - a.distance)[0];
    centers.push([...values[selected.i]]);
  }
  let assignments = [];
  for (let pass = 0; pass < 30; pass++) {
    if (signal?.aborted) throw new Error('操作已取消');
    const next = values.map(v => centers.map(c => cosine(v, c)).reduce((best, s, i, scores) => s > scores[best] ? i : best, 0));
    if (next.every((n, i) => n === assignments[i])) break;
    assignments = next;
    for (let c = 0; c < count; c++) {
      const members = values.filter((_, i) => assignments[i] === c);
      if (members.length) {
        const mean = centers[c].map((_, d) => members.reduce((sum, v) => sum + v[d], 0) / members.length);
        if (mean.some(n => n !== 0)) centers[c] = vector(mean);
      }
    }
  }
  return { groups: Array.from({ length: count }, (_, group) => ({ group, indices: assignments.flatMap((n, i) => n === group ? [i] : []) })) };
}

module.exports = { similarity, classify, cluster, cosine, vector };
