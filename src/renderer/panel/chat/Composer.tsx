import { t } from '../../../shared/i18n';
import React, { useEffect, useRef, useState } from 'react';
import type { OutboxItem, Panel, PanelMode } from '../../../shared/types';
import { WORK_MODES } from '../../../shared/types';
import { api } from '../../core/api';
import { useWorkspace } from '../../core/useWorkspace';
import { IconDatabase, IconQuote, IconSend, IconStop, IconMic } from '../../ui/icons';
import { FileRefPicker } from '../FileRefPicker';
import { ModelList } from '../ModelList';
import { Outbox } from './Outbox';
import { readDraft, writeDraft } from './drafts';
import { shotUrl } from './format';
import type { ChatQuote } from './types';

/** 盾牌 —— 权限那一格用。icons.tsx 里没有，就地画一个，免得为它动公共图标表 */
const IconShield = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" />
  </svg>
);

/**
 * 用量那串的短版 —— 插件给的是「40.7M · 命中 97% · ¥5.262 · 进行中」，
 * 窄的时候只留第一段（token 总数）：够知道个大概，剩下的在悬停里。
 */
const shortStatus = (t: string) => t.split('·')[0].trim();

/** 排队 —— icons.tsx 里没有，就地画一个，免得为它动公共图标表 */
const IconQueue = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 7h11M4 12h11M4 17h7" />
    <path d="M18 13v6M15 16h6" />
  </svg>
);

/**
 * 输入区：文本框 + 一条工具栏。
 *   · 左边「＋」引用工作区文件（插 `@路径`，发出去时带上文件内容）
 *   · 中间是**权限**：这一步会不会越出工作区，发出去之前就看得见
 *   · 右边**模型选择**就贴在输入框上（这个窗口用哪个模型，一眼看到、随手能换）
 *   · 最右是发送/停止
 *
 * 草稿、待发的图、是否在跑属于"这一轮要发出去的东西"，由 ChatDock 拿着
 * （发完要清空、要滚到最新一条，都在那边）；模型选择、权限菜单、文件选择器
 * 只是这个输入区自己的开合，就留在这里。
 */
export function Composer({
  panel,
  hostKey,
  busy,
  send,
  queueUp,
  steerNow,
  queue,
  restartArmed,
  inputRef,
  quotes,
  onRemoveQuote,
  onClearQuotes,
}: {
  panel: Panel;
  hostKey: string;
  busy: boolean;
  send(text: string, pics: string[]): void;
  /** 排队：不打断这一轮，跑完自动接着发 */
  queueUp(text: string, pics: string[]): void;
  /** 插话：送进此刻正在跑的那一轮 */
  steerNow(text: string, pics: string[]): Promise<boolean>;
  /** 面板上那些还没发出去的话（队列条要画它） */
  queue: OutboxItem[];
  /** 全局挂着"等全部会话结束就重启"：回车一律转成排队，想现在发就得插队 */
  restartArmed?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  quotes?: ChatQuote[];
  onRemoveQuote?: (id: string) => void;
  onClearQuotes?: () => void;
}) {
  const ws = useWorkspace();
  const localRef = useRef<HTMLTextAreaElement>(null);

  // VAD 自动断句与连续音频流状态
  const actualRef = inputRef ?? localRef;
  const [draft, setDraft] = useState(() => readDraft(panel.id)?.draft ?? panel.draft ?? '');
  /**
   * 本地最后一次**送进主进程**的草稿值。
   * 广播带回的 panel.draft 是主进程那份快照：它既可能滞后 1.5 秒，也会在每次
   * 广播 / hydrate 时把旧值送回来 —— 不认这条就会拿旧快照覆盖正打着的字，
   * 发送后更会把刚发出去的原文塞回输入框（"快照回档"）。
   */
  const lastSynced = useRef(draft);
    const [isTranscribing, setIsTranscribing] = useState(false);

  /**
   * 别处（语音转写、别的窗口）真改了 panel.draft 才同步进来，两条不许覆盖：
   *   · 带回的值等于 lastSynced → 是自己写出去的回声，不用再搬回来
   *   · 本地 draft ≠ lastSynced → 手上还有没送出去的新字，本地为准
   */
  useEffect(() => {
    const incoming = panel.draft || '';
    if (incoming === lastSynced.current) return;
    if (draft !== lastSynced.current) return;
    if (incoming !== draft) setDraft(incoming);
    // draft 刻意不进依赖：它每次都变，进了就会把"回灌"变成"每次打字都跑一遍"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.draft]);

  const [shots, setShots] = useState<string[]>(() => readDraft(panel.id)?.shots ?? []);

  const hasContent = Boolean(draft.trim() || shots.length || (quotes && quotes.length));

  const lastDraft = useRef(draft);
  useEffect(() => {
    writeDraft(panel.id, { draft, shots });
    lastDraft.current = draft;
    const t = setTimeout(() => {
      // 落地才记账：广播可能比回执先到，先记会把主进程的旧快照误当回声放进来
      void Promise.resolve(api.panel.patch(panel.id, { draft })).then(() => {
        lastSynced.current = draft;
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [panel.id, draft, shots]);

  useEffect(() => {
    const id = panel.id;
    return () => {
      void api.panel.patch(id, { draft: lastDraft.current });
    };
  }, [panel.id]);

  const insertRef = (path: string) => {
    setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${path} `);
    actualRef.current?.focus();
  };

  const doSend = () => {
    const text = draft.trim();
    if (!hasContent || busy) return;
    const pics = shots;
    setDraft('');
    setShots([]);
    void send(text, pics);
  };

  const doQueueUp = () => {
    const text = draft.trim();
    if (!hasContent) return;
    const pics = shots;
    setDraft('');
    setShots([]);
    void queueUp(text, pics);
  };

  const doSteerNow = async () => {
    const text = draft.trim();
    if (!hasContent || !busy) return;
    const pics = shots;
    setDraft('');
    setShots([]);
    const ok = await steerNow(text, pics);
    if (!ok) {
      setDraft(text);
      setShots(pics);
    }
  };

  const [models, setModels] = useState(false);
  const [refs, setRefs] = useState(false);
  const [perm, setPerm] = useState(false);
  const [modePick, setModePick] = useState(false);
  // 不写 = auto（自主）：老面板一个字不用改，露出来的就是缺省那一格
  const mode = panel.mode ?? 'auto';
  const rawModeName = WORK_MODES.find((m) => m.id === mode)?.name ?? '自主';
  const modeName = t(rawModeName);
  // 先看这个会话自己选的，没选过就退到它所在窗口的兜底
  const info = ws?.models[panel.id] ?? ws?.models[hostKey];

  // 斜杠命令弹层：只在草稿还是"/词"（整段就一个词、以 / 开头）时露脸 ——
  // 敲了空格就是在写参数了，选命令的阶段已经过去，回车该老老实实发送。
  const cmds = ws?.commands ?? [];
  const typingCmd = /^\/[^\s]*$/.test(draft);
  const hits = typingCmd ? cmds.filter((c) => c.id.startsWith(draft.slice(1))) : [];
  const [cmdSel, setCmdSel] = useState(0);
  const [cmdOff, setCmdOff] = useState(false);
  const showCmd = typingCmd && hits.length > 0 && !cmdOff;
  const sel = showCmd ? Math.min(cmdSel, hits.length - 1) : 0;
  /** 补全成 `/id `（带尾空格，接着写参数）—— 弹层随即自己收掉（草稿不再是单个词） */
  const pickCmd = (id: string) => {
    setDraft(`/${id} `);
    setCmdOff(false);
    setCmdSel(0);
    actualRef.current?.focus();
  };

  return (
      <div className={`composer${restartArmed ? ' is-queued' : ''}`}>
        {/* 排队条：还没发出去的话就摆在输入框**上面** —— 跟输入框的距离最近，
            而且它属于"要发出去的东西"，不该混进上面的对话里。 */}
        <Outbox panelId={panel.id} queue={queue} busy={busy} restartArmed={restartArmed} />

        {/* 叠加引用栏：文字与图片引用条目，支持叠加与单项移除 */}
        {quotes && quotes.length > 0 && (
          <div className="composer-quotes">
            <div className="quotes-list">
              {quotes.map((q) => (
                <div key={q.id} className={`quote-badge is-${q.type}`}>
                  {q.type === 'text' ? (
                    <>
                      <span className="quote-badge-icon">
                        <IconQuote />
                      </span>
                      <span className="quote-badge-text" title={q.content}>
                        {q.content.length > 42 ? q.content.slice(0, 42) + '…' : q.content}
                      </span>
                    </>
                  ) : (
                    <>
                      <img className="quote-badge-thumb" src={shotUrl(q.content)} alt="" />
                      <span className="quote-badge-text">{t('图片引用')}</span>
                    </>
                  )}
                  <button
                    className="quote-badge-close"
                    onClick={() => onRemoveQuote?.(q.id)}
                    title={t('移除此项引用')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {quotes.length > 1 && (
              <button className="quotes-clear-all" onClick={onClearQuotes} title={t('清空全部引用')}>
                清空
              </button>
            )}
          </div>
        )}

        {shots.length > 0 && (
          <div className="shots">
            {shots.map((s, i) => (
              <div className="shot" key={i}>
                <img src={s} alt="" />
                <button onClick={() => setShots((all) => all.filter((_, j) => j !== i))} title={t('去掉这张')}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}


        <textarea
          ref={actualRef}
          value={draft}
          rows={2}
          placeholder={t('说点什么，或让它改写这个面板（@ 引用文件）')}
          onChange={(e) => {
            setDraft(e.target.value);
            setCmdSel(0);
            setCmdOff(false); // 动了字就重新给机会 —— Esc 关掉只是对这一刻有效
          }}
          onPaste={(e) => {
            // 剪贴板里有图就用图，没有就当普通文本粘贴 —— 不要抢掉正常粘贴
            const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/'));
            if (!items.length) return;
            e.preventDefault();
            void Promise.all(
              items.map(
                (it) =>
                  new Promise<string>((res) => {
                    const f = it.getAsFile();
                    if (!f) return res('');
                    const r = new FileReader();
                    r.onload = () => res(String(r.result));
                    r.onerror = () => res('');
                    r.readAsDataURL(f);
                  }),
              ),
            ).then((list) => {
              const ok = list.filter(Boolean);
              if (ok.length) setShots((s) => [...s, ...ok]);
            });
          }}
          onKeyDown={(e) => {
            // 中文输入法正在选词时敲回车/空格，绝不触发发送或命令选中
            if (e.nativeEvent.isComposing || (e as any).keyCode === 229) {
              return;
            }
            // 弹层开着时：↑↓ 选、回车/Tab 补全、Esc 收起 —— 这时候回车还轮不到"发送"
            if (showCmd) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCmdSel((s) => (s + 1) % hits.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCmdSel((s) => (s - 1 + hits.length) % hits.length);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                pickCmd(hits[sel].id);
                return;
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                pickCmd(hits[sel].id);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setCmdOff(true);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              /**
               * 它在跑的时候，回车**不是发送**（也不该打断它）：
               *   · 回车        → 排队：跑完自动接着发（安全的那条，所以是默认手势）
               *   · Ctrl/⌘+回车 → 插话：直接送进正在跑的这一轮（要打断它的节奏，所以费点劲）
               * 它没在跑就照旧是发送。
               */
              if (busy) {
                if (e.ctrlKey || e.metaKey) void doSteerNow();
                else void doQueueUp();
                return;
              }
              /**
               * 挂着"等全部会话结束就重启"的时候，回车也**不是发送**：
               *   · 回车        → 排队：等重启完新进程替它发出去
               *   · Ctrl/⌘+回车 → 插队：不用等重启，现在就发
               * 和"它正在跑"是同一套手势 —— 不让用户记两套。
               */
              if (restartArmed) {
                if (e.ctrlKey || e.metaKey) void doSend();
                else void doQueueUp();
                return;
              }
              void doSend();
            }
          }}
        />

        {/* 斜杠命令候选：贴在输入框上方，↑↓ 选、回车补全、点一下也行 */}
        {showCmd && (
          <div className="slash-pop">
            <div className="sp-head">{t('斜杠命令 — 回车补全，补全后再回车发送')}</div>
            {hits.map((c, i) => (
              <button
                key={c.id}
                className={`sp-item${i === sel ? ' is-sel' : ''}`}
                onMouseDown={(ev) => {
                  ev.preventDefault(); // 别把焦点从输入框抢走
                  pickCmd(c.id);
                }}
              >
                <span className="sp-id">/{c.id}</span>
                <span className="sp-hint">{c.hint || c.label || ''}</span>
              </button>
            ))}
          </div>
        )}

        <div className="composer-bar">
          <button className={`cbtn${refs ? ' is-on' : ''}`} onClick={() => setRefs((v) => !v)} title={t('引用文件')}>
            ＋
          </button>

          {/* 权限贴在输入框上：这一步会不会越出工作区，发出去之前就看得见。
              **它只属于这一个会话** —— 面板上存着自己那一份（panel.fullAccess）。 */}
          <div className="perm">
            <button
              className={`perm-chip${panel.fullAccess ? ' is-on' : ''}`}
              onClick={() => setPerm((v) => !v)}
              title={t('文件权限')}
            >
              <IconShield />
              {/* 全称和短版都在 DOM 里，哪一份露脸由 CSS 按这条工具栏的宽度定
                  （见 composer.css 末尾那些 @container）—— 窄了就把字让掉，
                  光靠盾牌的颜色 + 悬停也能看出走的是哪一条 */}
              <span className="p-full">{panel.fullAccess ? t('完全权限') : t('工作区内')}</span>
              <span className="chip-caret">▾</span>
            </button>

            {perm && (
              <>
                <div className="perm-mask" onClick={() => setPerm(false)} />
                <div className="perm-menu">
                  {[
                    { on: false, name: t('工作区内'), desc: t('只能读写工作区目录里的文件') },
                    { on: true, name: t('完全权限'), desc: t('任意路径 —— 够得到 ensoul 自己') },
                  ].map((o) => (
                    <button
                      key={o.name}
                      className={`perm-item${Boolean(panel.fullAccess) === o.on ? ' is-on' : ''}`}
                      onClick={() => {
                        setPerm(false);
                        void api.settings.setFullAccess(panel.id, o.on);
                      }}
                    >
                      <span className="perm-item-name">{o.name}</span>
                      <span className="perm-item-desc">{o.desc}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 工作模式 —— 贴在**权限右边**，同样是一枚可点开的 chip：
              四种模式共用同一张工具表，点一下只换框里那几行规矩（见 chat-core 的 modeSection）。 */}
          <div className="mode">
            <button
              className={`mode-chip${mode !== 'auto' ? ' is-on' : ''}`}
              onClick={() => setModePick((v) => !v)}
              title={t('工作模式')}
            >
              <span className="m-name">{modeName}</span>
              <span className="chip-caret">▾</span>
            </button>

            {modePick && (
              <>
                <div className="perm-mask" onClick={() => setModePick(false)} />
                <div className="mode-menu">
                  {WORK_MODES.map((m) => (
                    <button
                      key={m.id}
                      className={`mode-item${mode === m.id ? ' is-on' : ''}`}
                      title={m.desc}
                      onClick={() => {
                        setModePick(false);
                        void api.settings.setPanelMode(panel.id, m.id as PanelMode);
                      }}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="composer-right">
            {/* 用量、花费这类东西现在由**插件**提供（见 plugins/usage-meter），
                核心只负责把它画出来 —— 关掉那个插件，这一块就干净消失，
                不用改这里一行代码。 */}
            {(ws?.status?.[panel.id] ?? [])
              .filter((s) => s.slot !== 'head')
              .map((s) => (
              <span className="usage-chip" key={s.id} title={s.title}>
                <IconDatabase />
                <span className="u-full">{s.text}</span>
                <span className="u-short">{shortStatus(s.text)}</span>
              </span>
            ))}
            {/* 员工面板的模型在**角色卡**里定死了：这里只报是哪只，不给换 ——
                一个岗位用什么模型是这个岗位的属性，不是每次对话随手挑的东西。 */}
            <button
              className={`model-chip${info?.hasKey ? '' : ' is-bare'}${panel.lockedModel ? ' is-locked' : ''}`}
              disabled={!!panel.lockedModel}
              onClick={() => setModels((v) => !v)}
              title={panel.lockedModel ? '由角色卡指定' : '换模型'}
            >
              <span className="chip-dot" />
              <span className="chip-name">{info?.model || '没配模型'}</span>
              <span className="chip-caret">▾</span>
            </button>

            {busy || restartArmed ? (
              <>
                {/* 它跑着的时候，两颗按钮是两条**不同**的路，别合成一颗：
                    排队 = 等整轮跑完再发；插话 = 现在这一步做完就送进去。
                    哪颗是主按钮看情况 —— 手上有草稿时，两边都得能一眼看到。 */}
                <button
                  className="send is-queue"
                  disabled={!hasContent}
                  onClick={() => void doQueueUp()}
                  title={restartArmed ? '排队，重启之后自动发（回车）' : '排队（回车）'}
                >
                  <IconQueue />
                </button>
                <button
                  className="send is-steer"
                  disabled={!hasContent}
                  onClick={() => (busy ? void doSteerNow() : void doSend())}
                  title={restartArmed ? '不等重启，现在就发（Ctrl/⌘+回车）' : '插话（Ctrl/⌘+回车）'}
                >
                  <IconSend />
                </button>
                {busy && (
                  <button className="send" onClick={() => void api.chat.stop(panel.id)} title={t('停止')}>
                    <IconStop />
                  </button>
                )}
              </>
            ) : (
              <>
                <button className="send primary" disabled={!hasContent} onClick={() => void doSend()} title={t('发送（回车）')}>
                  <IconSend />
                </button>
              </>
            )}
          </div>
        </div>

        {refs && <FileRefPicker onPick={insertRef} onClose={() => setRefs(false)} />}
        {models && <ModelList panelId={panel.id} onClose={() => setModels(false)} />}
      </div>
  );
}
