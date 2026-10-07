import * as fs from 'fs';
import { appPath, homeDir } from './paths';
import * as path from 'path';

import { workspaceRoot } from './fsapi';
import type { SkillInfo } from '../shared/types';
import { t } from '../shared/i18n';

/**
 * 技能：一个目录里的若干份说明，每份是 `SKILL.md`（或根上的一个 `.md`）。
 *
 * 为什么是这个形态 —— 整套机制里唯一重要的设计决定：
 * 技能正文往往很长（接线细节、踩过的坑、成串的约束），全塞进系统提示就等于
 * 每一轮都在为这次用不上的知识付费。所以系统提示里只放「名字 + 一句话描述」，
 * 模型觉得对得上，再用 use_skill 工具把正文取回来。
 *
 * frontmatter 只认三个键，别的键不解析也不报错：
 *
 *   ---
 *   name: comfyui-draw
 *   description: 用 ComfyUI 画图时怎么连、怎么选模型
 *   whenToUse: 用户说要画图 / 出图 / 换模型时
 *   ---
 *
 * 没有 frontmatter 一样能用：目录名当名字，整份当正文。
 *
 * ── 多根（root / rank 那套）────────────────────────────────────────────
 *
 * 技能不是一个目录，是**一串目录**，优先级从高到低：
 *
 *   1. `<工作区>/.ensoul/skills`  这个项目自己的
 *   2. `<工作区>/.agents/skills`   通用约定
 *   3. 插件自报的那些（见下面 addSkillRoot）—— 各插件按自己的规矩摆放技能库
 *   4. `<应用目录>/skills`         软件自带，兜底
 *
 * 重名时**先出现的赢**，后面的整条忽略（不会出现两个同名技能打架）。
 * 每次用都是重新扫盘 —— 刚写好的技能立刻可见。
 *
 * 为什么插件那几根要由插件自己报：某本技能库落在哪个目录，是**那个插件的知识**。
 * 核心写死一份"还认这几个目录"的名单，等于每加一个插件都得回来改核心，而且
 * 核心也就顺带知道了那些插件叫什么 —— 两样都不该。
 */

const ENTRY = 'SKILL.md';

/** 应用目录里那个兜底根 */
export function skillsDir(): string {
  return appPath('skills');
}

export interface SkillRoot {
  /** 绝对路径 */
  path: string;
  /** 给人看的来源，写进 SkillInfo.source */
  source: string;
  /** 越小越优先 */
  rank: number;
}

/**
 * 插件自报的技能根 —— 插件装载时调 addSkillRoot 登记，核心不认识具体目录名。
 * rank 决定它排在哪儿（越小越优先），跟内置那几根同一把尺子。
 */
const pluginRoots: SkillRoot[] = [];

/** 登记一根（同一个绝对路径只认第一次；插件重载时重复调不会叠加） */
export function addSkillRoot(dir: string, source: string, rank = 40): void {
  if (!dir) return;
  const p = path.resolve(dir);
  if (pluginRoots.some((r) => r.path === p)) return;
  pluginRoots.push({ path: p, source, rank });
}

/** 撤掉某一批（按来源标签前缀认领）—— 插件被停用/卸掉时把它的根一并收走 */
export function dropSkillRoots(fromSource: string): void {
  const key = String(fromSource || "").trim();
  if (!key) return;
  for (let i = pluginRoots.length - 1; i >= 0; i--) {
    if (pluginRoots[i].source.startsWith(key)) pluginRoots.splice(i, 1);
  }
}

/** 现在一共扫了哪些目录（设置面板要显示这个） */
export function skillRoots(): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const push = (dir: string, source: string, rank: number) => {
    if (!dir) return;
    roots.push({ path: path.resolve(dir), source, rank });
  };

  const ws = workspaceRoot();
  if (ws) {
    push(path.join(ws, '.ensoul', 'skills'), t('工作区 .ensoul'), 10);
    push(path.join(ws, '.agents', 'skills'), t('工作区 .agents'), 30);
  }

  const home = safeHome();
  if (home) {
    push(path.join(home, '.agents', 'skills'), t('用户 .agents'), 55);
  }
  // 插件自报的那些：核心只管"有这几根、按 rank 排"，它们叫什么、在哪儿由插件说
  for (const r of pluginRoots) push(r.path, r.source, r.rank);
  push(skillsDir(), t('软件自带'), 60);

  return roots.sort((a, b) => a.rank - b.rank);
}

/** 用户主目录。拿不到就跳过用户级技能，不算错 */
function safeHome(): string {
  try {
    return homeDir();
  } catch {
    try {
      return homeDir();
    } catch {
      return '';
    }
  }
}

/** 极小 frontmatter 解析：只为了拿 name / description / whenToUse，不引依赖 */
export function parseFront(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    meta[k] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** 一个根里的一份技能：目录 + SKILL.md，或者根上的一个 .md 文件，支持二级分类 */
function readOne(
  file: string,
  dir: string,
  root: SkillRoot,
  fallbackName: string,
  category?: string,
): SkillInfo | null {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 读不出来的不算技能
  }
  const { meta } = parseFront(text);
  const name = (meta.name || fallbackName).trim();
  if (!name) return null;
  return {
    name,
    description: meta.description || '',
    whenToUse: meta.whenToUse || '',
    dir,
    category: meta.category || category,
    file,
    bytes: Buffer.byteLength(text, 'utf8'),
    enabled: true,
    source: root.source,
    root: root.path,
  };
}

/** 扫一遍所有技能根。每次重新读盘 —— 刚写好的技能立刻可见，不用重启。支持二级目录分类 */
export function scanSkills(disabled: string[] = []): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const root of skillRoots()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue; // 没有这个目录不是错误
    }

    // 同一根里按名字排序，扫出来的顺序才是稳定的
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;

      if (e.isDirectory()) {
        // 1. 先看这个目录自身是不是一个技能（如 skills/troubleshoot/SKILL.md 或 skills/frontend/SKILL.md 领域导航）
        const topHit = readOne(path.join(root.path, e.name, ENTRY), e.name, root, e.name);
        if (topHit) {
          const key = topHit.name.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            topHit.enabled = !disabled.includes(topHit.name);
            out.push(topHit);
          }
        }

        // 2. 检查二级分类子目录（支持 skills/<领域>/<细则>/SKILL.md 或 skills/<领域>/<细则>.md）
        try {
          const subEntries = fs.readdirSync(path.join(root.path, e.name), { withFileTypes: true });
          subEntries.sort((a, b) => a.name.localeCompare(b.name));
          for (const sub of subEntries) {
            if (sub.name.startsWith('.')) continue;
            let subHit: SkillInfo | null = null;
            if (sub.isDirectory()) {
              const subSkillFile = path.join(root.path, e.name, sub.name, ENTRY);
              subHit = readOne(subSkillFile, `${e.name}/${sub.name}`, root, `${e.name}/${sub.name}`, e.name);
            } else if (sub.isFile() && sub.name.toLowerCase().endsWith('.md')) {
              const baseName = sub.name.replace(/\.md$/i, '');
              // 排除自身的根说明
              if (baseName.toUpperCase() !== 'SKILL' && baseName.toUpperCase() !== 'README' && baseName.toUpperCase() !== 'INDEX') {
                const subSkillFile = path.join(root.path, e.name, sub.name);
                subHit = readOne(subSkillFile, `${e.name}/${baseName}`, root, `${e.name}/${baseName}`, e.name);
              }
            }
            if (!subHit) continue;
            const subKey = subHit.name.toLowerCase();
            if (!seen.has(subKey)) {
              seen.add(subKey);
              subHit.enabled = !disabled.includes(subHit.name);
              out.push(subHit);
            }
          }
        } catch {
          // 读取子目录失败忽略
        }
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const baseName = e.name.replace(/\.md$/i, '');
        const hit = readOne(path.join(root.path, e.name), baseName, root, baseName);
        if (hit) {
          const key = hit.name.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            hit.enabled = !disabled.includes(hit.name);
            out.push(hit);
          }
        }
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 系统提示里那一段：只有名字和一句话，绝不带正文。
 *
 * 描述也要封顶：这份清单
 * **每一轮都在系统提示里**，某条技能把 description 写成三百字小作文，
 * 就成了每轮都要付的固定开销。截断只是让摘要短一点，正文仍然一个字不少。
 */
const DESC_MAX = 500;

export function skillDigest(disabled: string[] = []): string {
  const list = scanSkills(disabled).filter((s) => s.enabled);
  if (!list.length) return '';
  return list
    .map((s) => {
      const raw = t(s.description) || t('（没写说明）');
      const desc = raw.length > DESC_MAX ? `${raw.slice(0, DESC_MAX)}…` : raw;
      return `- ${s.name}：${desc}${s.whenToUse ? t('（什么时候用：') + t(s.whenToUse) + t('）') : ''}`;
    })
    .join('\n');
}

/** 取正文。支持完整路径名或短名命中，名字对不上时把现有的列出来，模型好自己纠正。 */
export function readSkill(name: string, disabled: string[] = []): string {
  const list = scanSkills(disabled);
  const rawWant = String(name ?? '').trim();
  const want = rawWant.toLowerCase();

  if (!want) {
    const have = list.map((s) => s.name).join('、') || '（一个技能都没有）';
    return `没有这个技能：${t('（没给名字）')}\n现有的：${have}`;
  }

  const hit =
    list.find((s) => s.name.toLowerCase() === want) ??
    list.find((s) => s.dir.toLowerCase() === want) ??
    // 二级技能容错：允许通过短名匹配，如 comfyui-draw 匹配 design/comfyui-draw
    list.find((s) => s.name.split('/').pop()?.toLowerCase() === want) ??
    list.find((s) => s.dir.split('/').pop()?.toLowerCase() === want) ??
    list.find((s) => s.name.toLowerCase().endsWith('/' + want)) ??
    list.find((s) => s.dir.toLowerCase().endsWith('/' + want));

  if (!hit) {
    const have = list.map((s) => s.name).join('、') || '（一个技能都没有）';
    return `没有这个技能：${rawWant}\n现有的：${have}`;
  }
  try {
    return fs.readFileSync(hit.file, 'utf8');
  } catch (e: any) {
    return `技能读不出来：${e?.message ?? e}`;
  }
}
