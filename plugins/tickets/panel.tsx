import React, { useEffect, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 派单队列面板 —— 看板 + 管理动作（撤单 / 恢复 / 验收结案 / 打回重做）。
 *
 * 读的只有一处：dispatch 的收件箱 `.ensoul/state/dispatch.inbox.json`。
 * 谁给谁派了什么活、走到谁手上、交没交，那边都写着 —— 这里只负责摊开、分组、算个"等了多久"。
 *
 * ══ 动作走命令队列，改账永远由 dispatch 主人执行 ═══════════════════════════
 */

const INBOX = '.ensoul/state/dispatch.inbox.json';
const CMD = '.ensoul/state/dispatch.cmd.json';

interface Ticket {
  token: string;
  at: number;
  fromName: string;
  task: string;
  holderName: string;
  hops: string[];
  status: string; // 'pending' | 'done' | 'accepted' | 'cancelled'
  by: string;
  note: string;
  files: string[];
  doneAt: number;
  acceptedAt?: number;
  cancelledAt: number;
  rejectedAt?: number;
  rejectCount?: number;
  lastRejectReason?: string;
  follow: string;
  score?: string;
  workSummary?: string;
  howSummary?: string;
}

/** 命令排队：连点两下也不会丢前一条 */
let chain: Promise<unknown> = Promise.resolve();
function enqueue(fs: PanelFaceProps['fs'], payload: Record<string, unknown>) {
  const run = async () => {
    let cmds: unknown[] = [];
    try {
      const j = JSON.parse(await fs.read(CMD));
      if (Array.isArray(j?.cmds)) cmds = j.cmds;
    } catch {
      cmds = [];
    }
    cmds.push(payload);
    await fs.write(CMD, JSON.stringify({ cmds: cmds.slice(-20) }));
  };
  chain = chain.then(run).catch(() => {});
  return chain;
}

/**
 * 收件箱解析：对脏数据与缺字段容错
 */
function pick(text: string): Ticket[] {
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : Array.isArray(j && j.entries) ? j.entries : [];
    return list
      .filter((item: any) => !!item && typeof item === "object" && !!item.token)
      .map((raw: any): Ticket => ({

          token: String(raw.token),
          at: Number(raw.at) || 0,
          fromName: typeof raw.fromName === 'string' ? raw.fromName : t('（没有来源）'),
          task: typeof raw.task === 'string' ? raw.task : '',
          holderName: typeof raw.holderName === 'string' ? raw.holderName : '',
          hops: Array.isArray(raw.hops) ? raw.hops.filter((h: unknown): h is string => typeof h === 'string') : [],
          status: typeof raw.status === 'string' ? raw.status : 'pending',
          by: typeof raw.by === 'string' ? raw.by : '',
          note: typeof raw.note === 'string' ? raw.note : '',
          files: Array.isArray(raw.files) ? raw.files.filter((f: unknown): f is string => typeof f === 'string') : [],
          doneAt: Number(raw.doneAt) || 0,
          acceptedAt: Number(raw.acceptedAt) || 0,
          cancelledAt: Number(raw.cancelledAt) || 0,
          rejectedAt: Number(raw.rejectedAt) || 0,
          rejectCount: Number(raw.rejectCount) || 0,
          lastRejectReason: typeof raw.lastRejectReason === 'string' ? raw.lastRejectReason : '',
          follow: typeof raw.follow === 'string' ? raw.follow : '',
          score: typeof raw.score === 'string' ? raw.score : '',
          workSummary: typeof raw.workSummary === 'string' ? raw.workSummary : '',
          howSummary: typeof raw.howSummary === 'string' ? raw.howSummary : '',
              }));
  } catch {
    return [];
  }
}

/** "3 分钟前" —— 挂了多久 */
function ago(from: number, now: number): string {
  if (!from) return '';
  const d = Math.max(0, now - from);
  if (d < 60_000) return t('{n} 秒前', { n: Math.floor(d / 1000) });
  if (d < 3_600_000) return t('{n} 分钟前', { n: Math.floor(d / 60_000) });
  if (d < 86_400_000) return t('{n} 小时前', { n: Math.floor(d / 3_600_000) });
  return t('{n} 天前', { n: Math.floor(d / 86_400_000) });
}

/** 时间戳带分 */
function clock(at: number): string {
  if (!at) return '—';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 任务正文的一行摘要 */
function firstLine(s: string): string {
  const line = s.split('\n').map((x) => x.trim()).find((x) => x && !x.startsWith('【')) ?? s.trim();
  return line || t('（没写任务内容）');
}

function Row({
  t: item,
  now,
  fs,
  pid,
  seq,
}: {
  t: Ticket;
  now: number;
  fs: PanelFaceProps['fs'];
  pid: string;
  seq: React.MutableRefObject<number>;
}) {
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState(t('未达到预期，请调整优化'));
  const [acceptMode, setAcceptMode] = useState(false);
  const [score, setScore] = useState(t('⭐⭐⭐⭐⭐ 优秀'));
  const [workSummary, setWorkSummary] = useState('');
  const [howSummary, setHowSummary] = useState('');

  const done = item.status === 'done';
  const accepted = item.status === 'accepted';
  const dead = item.status === 'cancelled';
  const spare = item.status === 'spare';
  const pending = !done && !dead && !accepted && !spare;
  const later = accepted
    ? item.acceptedAt || item.doneAt || item.at
    : done
    ? item.doneAt || item.at
    : spare
    ? (t as any).sparedAt || item.at
    : dead
    ? item.cancelledAt || item.at
    : item.at;

  const act = (cmd: 'cancelTicket' | 'restoreTicket') => (e: React.MouseEvent) => {
    e.stopPropagation();
    seq.current += 1;
    void enqueue(fs, { seq: Date.now() * 1000 + (seq.current % 1000), panelId: pid, cmd, token: item.token });
  };

  const doAccept = (e: React.MouseEvent) => {
    e.stopPropagation();
    seq.current += 1;
    const isStarred = !score.includes(t('合格')) && !score.includes(t('部分'));
    void enqueue(fs, {
      seq: Date.now() * 1000 + (seq.current % 1000),
      panelId: pid,
      cmd: 'acceptTicket',
      token: item.token,
      starred: isStarred,
      level: isStarred ? 'confirmed' : 'partial',
      score: score.trim() || t('🌟 肯定'),
      work: workSummary.trim() || firstLine(item.task),
      how: howSummary.trim() || (item.note || (item.files.length ? item.files.map((f) => f.split(/[/\\]/).pop()).join(', ') : t('按规范完成'))),
    });
    setAcceptMode(false);
  };

  const doAcceptDirect = (starred: boolean) => (e: React.MouseEvent) => {
    e.stopPropagation();
    seq.current += 1;
    void enqueue(fs, {
      seq: Date.now() * 1000 + (seq.current % 1000),
      panelId: pid,
      cmd: 'acceptTicket',
      token: item.token,
      starred,
      level: starred ? 'confirmed' : 'partial',
      score: starred ? t('🌟 肯定') : t('✔️ 部分肯定'),
      work: workSummary.trim() || firstLine(item.task),
      how: howSummary.trim() || (item.note || (item.files.length ? item.files.map((f) => f.split(/[/\\]/).pop()).join(', ') : t('按规范完成'))),
    });
  };

  const doSpare = (e: React.MouseEvent) => {
    e.stopPropagation();
    seq.current += 1;
    void enqueue(fs, {
      seq: Date.now() * 1000 + (seq.current % 1000),
      panelId: pid,
      cmd: 'spareTicket',
      token: item.token,
    });
  };

  const doReject = (e: React.MouseEvent) => {
    e.stopPropagation();
    seq.current += 1;
    void enqueue(fs, {
      seq: Date.now() * 1000 + (seq.current % 1000),
      panelId: pid,
      cmd: 'rejectTicket',
      token: item.token,
      reason: rejectReason.trim() || t('未达到预期，请调整优化'),
    });
    setRejectMode(false);
  };

  return (
    <div
      className={`tk-row ${
        accepted ? 'is-accepted' : done ? 'is-done' : dead ? 'is-dead' : 'is-waiting'
      }${open ? ' is-open' : ''}`}
      onClick={() => setOpen((v) => !v)}
    >
      <div className="tk-head">
        <span className="tk-token">{item.token}</span>
        <span className="tk-route">
          {item.fromName}
          <span className="tk-arrow">→</span>
          {item.holderName || t('（还没落到人手上）')}
        </span>
        {Boolean(item.score) && (
          <span className="tk-score-tag" title={t('验收评分与肯定')}>
            {item.score}
          </span>
        )}
        {Boolean(item.rejectCount && item.rejectCount > 0) && (
          <span className="tk-reject-tag" title={item.lastRejectReason ? `最近驳回：${item.lastRejectReason}` : t('已被打回修改')}>
            打回 ×{item.rejectCount}
          </span>
        )}
        <span className="tk-time" title={clock(later)}>
          {pending
            ? `等了 ${ago(item.at, now)}`
            : accepted
            ? `结于 ${ago(later, now)}`
            : done
            ? `交于 ${ago(later, now)}`
            : `撤于 ${ago(later, now)}`}
        </span>
        {pending && (
          <button className="tk-btn" onClick={act('cancelTicket')} title={t('撤单：不再算欠着')}>
            {t('撤单')}
          </button>
        )}
        {dead && (
          <button className="tk-btn" onClick={act('restoreTicket')} title={t('恢复成等交付')}>
            {t('恢复')}
          </button>
        )}
        {(done || spare) && (
          <>
            <button
              className="tk-btn tk-btn-accept"
              onClick={doAcceptDirect(true)}
              title={t('老板肯定：计入员工已完成工作，并加 ⭐ 星标')}
            >
              🌟 肯定(星标)
            </button>
            <button
              className="tk-btn tk-btn-accept"
              onClick={doAcceptDirect(false)}
              title={t('老板部分肯定：计入员工已完成工作，普通记录')}
            >
              ✔️ 部分肯定
            </button>
            {!spare && (
              <button
                className="tk-btn"
                onClick={doSpare}
                title={t('老板没否定也没肯定：放入备用池，暂时不作为已完成工作')}
              >
                {t('📦 备用池')}
              </button>
            )}
            <button
              className="tk-btn tk-btn-reject"
              onClick={(e) => {
                e.stopPropagation();
                setRejectMode((v) => !v);
                setAcceptMode(false);
              }}
              title={t('老板否定：直接打回，绝对不计入已完成工作')}
            >
              ❌ 否定打回
            </button>
            <button
              className="tk-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (!workSummary) setWorkSummary(firstLine(item.task));
                if (!howSummary) setHowSummary(item.note || (item.files.length ? item.files.map((f) => f.split(/[/\\]/).pop()).join(', ') : t('按规范完成')));
                setAcceptMode((v) => !v);
                setRejectMode(false);
              }}
              title={t('派单人浮动微调评价/实现路径（选填）')}
            >
              ✏️ 浮动调整
            </button>
          </>
        )}
      </div>

      {acceptMode && (
        <div className="tk-accept-form" onClick={(e) => e.stopPropagation()}>
          <div className="tk-form-title">
            <span>{t('★ 肯定验收并打分（计入「')}{item.holderName || t('承办人')}」完成的工作）</span>
          </div>
          <div className="tk-form-row">
            <span className="tk-form-label">{t('评分：')}</span>
            <div className="tk-score-options">
              {[t('⭐⭐⭐⭐⭐ 优秀'), t('⭐⭐⭐⭐ 良好'), t('⭐⭐⭐ 合格')].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`tk-score-btn ${score === s ? 'is-active' : ''}`}
                  onClick={() => setScore(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="tk-form-row">
            <span className="tk-form-label">{t('做了什么：')}</span>
            <input
              className="tk-form-input"
              value={workSummary}
              onChange={(e) => setWorkSummary(e.target.value)}
              placeholder={t('任务凝练成一句话，如：为八通出头像4版')}
            />
          </div>
          <div className="tk-form-row">
            <span className="tk-form-label">{t('实现路径：')}</span>
            <input
              className="tk-form-input"
              value={howSummary}
              onChange={(e) => setHowSummary(e.target.value)}
              placeholder={t('工作流、规格或交付要点，如：使用 krea2 工作流...')}
            />
          </div>
          <div className="tk-form-actions">
            <button className="tk-btn tk-btn-accept" onClick={doAccept}>
              {t('确认肯定并计入成功案例')}
            </button>
            <button className="tk-btn" onClick={() => setAcceptMode(false)}>
              {t('取消')}
            </button>
          </div>
        </div>
      )}

      {rejectMode && (
        <div className="tk-reject-form" onClick={(e) => e.stopPropagation()}>
          <input
            className="tk-reject-input"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={t('填写驳回意见...')}
            autoFocus
          />
          <button className="tk-btn tk-btn-reject" onClick={doReject}>
            {t('确认打回（不计入工作）')}
          </button>
          <button className="tk-btn" onClick={() => setRejectMode(false)}>
            {t('取消')}
          </button>
        </div>
      )}

      <div className="tk-task">{open ? item.task : firstLine(item.task)}</div>
      {item.lastRejectReason && open && (
        <div className="tk-files" style={{ color: '#e0674f' }}>
          驳回意见：{item.lastRejectReason}
        </div>
      )}
      {accepted && (item.workSummary || item.howSummary) && open && (
        <div className="tk-files" style={{ color: '#8fd6a8', marginTop: 4 }}>
          ✓ 已计入「{item.holderName || item.by}」完成的工作：{item.workSummary} {item.howSummary ? `（${item.howSummary}）` : ''}
        </div>
      )}
      {open && !!item.hops.length && <div className="tk-files">{item.hops.join('  ')}</div>}
      {open && (done || accepted) && (item.files.length > 0 || item.note) && (
        <div className="tk-files">
          {item.note && <div className="tk-note">{item.note}</div>}
          {item.files.length > 0 && (
            <>
              <span
                className="tk-more"
                onClick={(e) => {
                  e.stopPropagation();
                  setFilesOpen((v) => !v);
                }}
              >
                {item.files.length} 个文件 {filesOpen ? t('· 收起') : t('· 点开看路径')}
              </span>
              {filesOpen && (
                <ul className="tk-paths">
                  {item.files.map((f) => (
                    <li key={f} title={f}>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
      {pending && item.follow && <div className="tk-follow">{t('交回来之后：')}{item.follow}</div>}
    </div>
  );
}

export default function TicketsPanel({ panel, fs }: PanelFaceProps) {
  const [list, setList] = useState<Ticket[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const text = await fs.read(INBOX);
        if (!alive) return;
        setList(pick(text));
      } catch {
        if (alive) setList([]);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    const beat = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(beat);
    };
  }, [panel.id]);

  const all = list ?? [];
  const waiting = all.filter((t) => t.status === 'pending').sort((a, b) => a.at - b.at);
  const dead = all
    .filter((t) => t.status === 'cancelled')
    .sort((a, b) => (b.cancelledAt || b.at) - (a.cancelledAt || a.at))
    .slice(0, 6);
  const done = all
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.doneAt || b.at) - (a.doneAt || a.at))
    .slice(0, 10);
  const spareList = all
    .filter((t) => t.status === 'spare')
    .sort((a, b) => ((b as any).sparedAt || b.at) - ((a as any).sparedAt || a.at))
    .slice(0, 10);
  const acceptedList = all
    .filter((t) => t.status === 'accepted')
    .sort((a, b) => (b.acceptedAt || b.doneAt || b.at) - (a.acceptedAt || a.doneAt || a.at))
    .slice(0, 10);

  return (
    <div className="tk">
      <div className="tk-top">
        <span className="tk-title">{panel.title}</span>
        <span className="tk-stats">
          {list === null
            ? t('读数中…')
            : t('欠着 {a} · 待验收 {b} · 备用池 {c} · 已结案 {d}', { a: waiting.length, b: done.length, c: spareList.length, d: acceptedList.length })}
        </span>
      </div>
      <div className="tk-list">
        <div className="tk-main">
          {list !== null && all.length === 0 && (
            <div className="tk-blank">
              派单收件箱还是空的（`.ensoul/state/dispatch.inbox.json`）。
              <br />
              {t('派出去一单，这里就会长出第一条。')}
            </div>
          )}
          {waiting.length > 0 && (
            <>
              <div className="tk-group">{t('等交付 ·')}{waiting.length}</div>
              {waiting.map((t) => (
                <Row key={t.token} t={t} now={now} fs={fs} pid={panel.id} seq={seq} />
              ))}
            </>
          )}
          {waiting.length === 0 && all.length > 0 && <div className="tk-blank">{t('没有欠着的活 —— 队列是清的。')}</div>}
        </div>
        <div className="tk-side">
          {done.length > 0 && (
            <>
              <div className="tk-group">{t('待验收交付 ·')}{done.length}</div>
              {done.map((t) => (
                <Row key={t.token} t={t} now={now} fs={fs} pid={panel.id} seq={seq} />
              ))}
            </>
          )}
          {spareList.length > 0 && (
            <>
              <div className="tk-group" style={{ color: '#ffd166' }}>{t('备用池（暂不计入） ·')}{spareList.length}</div>
              {spareList.map((t) => (
                <Row key={t.token} t={t} now={now} fs={fs} pid={panel.id} seq={seq} />
              ))}
            </>
          )}
          {acceptedList.length > 0 && (
            <>
              <div className="tk-group">{t('已验收结案 ·')}{acceptedList.length}</div>
              {acceptedList.map((t) => (
                <Row key={t.token} t={t} now={now} fs={fs} pid={panel.id} seq={seq} />
              ))}
            </>
          )}
          {dead.length > 0 && (
            <>
              <div className="tk-group">{t('已撤单 ·')}{dead.length}</div>
              {dead.map((t) => (
                <Row key={t.token} t={t} now={now} fs={fs} pid={panel.id} seq={seq} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
