import React, { useEffect, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 纯正 Edge 风格轻量内嵌浏览器面板
 * 核心浏览必需：导航（后退/前进/刷新）、Edge 药丸地址栏、外部系统浏览器打开、原生缩放控制
 */

const WV = 'webview' as unknown as React.ElementType;

function resolveInput(val: string): string {
  const s = String(val || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('localhost') || s.startsWith('127.0.0.1') || /^192\.168\./.test(s) || /^10\./.test(s)) {
    return `http://${s}`;
  }
  if (!s.includes(' ') && s.includes('.')) {
    return `https://${s}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

// 优雅 Edge 细线 SVG 图标
const IconBack = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13L5 8L10 3" />
  </svg>
);

const IconForward = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3L11 8L6 13" />
  </svg>
);

const IconReload = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.5 8A5.5 5.5 0 1 1 11.5 3.9L14 3.5V7H10.5" />
  </svg>
);

const IconLock = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6.5" width="10" height="7.5" rx="1.5" />
    <path d="M5.5 6.5V4.5A2.5 2.5 0 0 1 10.5 4.5V6.5" />
  </svg>
);

const IconWarning = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <line x1="8" y1="5" x2="8" y2="8.5" />
    <circle cx="8" cy="11" r="0.6" fill="currentColor" />
  </svg>
);

const IconExternal = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3H3.5A1.5 1.5 0 0 0 2 4.5V12.5A1.5 1.5 0 0 0 3.5 14H11.5A1.5 1.5 0 0 0 13 12.5V9" />
    <path d="M10 2H14V6" />
    <path d="M14 2L7 9" />
  </svg>
);

export default function BrowserPanelFace({ panel, patch }: PanelFaceProps) {
  const target = String(panel.spec?.text || '').trim();
  const [draft, setDraft] = useState<string>(target);
  const [nav, setNav] = useState({ back: false, fwd: false });
  const [loading, setLoading] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [err, setErr] = useState<{ code?: number; desc?: string; url?: string } | null>(null);

  const wv = useRef<any>(null);
  const bar = useRef<HTMLInputElement>(null);

  // 外部 target 变化时同步到地址输入框
  useEffect(() => {
    if (target) {
      setDraft(target);
      setErr(null);
    }
  }, [target]);

  // 事件监听器仅在首次挂载时绑定一次，严防频繁卸载和循环触发导致闪烁
  useEffect(() => {
    const el = wv.current;
    if (!el) return;

    const syncState = () => {
      try {
        const u = el.getURL() || '';
        setNav({ back: !!el.canGoBack(), fwd: !!el.canGoForward() });
        if (u && u !== 'about:blank' && document.activeElement !== bar.current) {
          setDraft(u);
        }
      } catch {
        /* 未就绪 */
      }
    };

    const onStart = () => {
      setLoading(true);
      setErr(null);
    };

    const onStop = () => {
      setLoading(false);
      syncState();
    };

    const onFail = (e: any) => {
      setLoading(false);
      if (e?.errorCode === -3) return; // ERR_ABORTED 正常取消不报错
      setErr({
        code: e?.errorCode,
        desc: e?.errorDescription,
        url: e?.validatedURL || target,
      });
      syncState();
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-finish-load', syncState);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('did-navigate', syncState);
    el.addEventListener('did-navigate-in-page', syncState);

    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-finish-load', syncState);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('did-navigate', syncState);
      el.removeEventListener('did-navigate-in-page', syncState);
    };
  }, []);

  const call = (method: string) => {
    try {
      wv.current?.[method]?.();
    } catch {
      /* 未就绪 */
    }
  };

  const navigate = (raw: string) => {
    const u = resolveInput(raw);
    if (!u) return;
    setErr(null);
    if (target === u) {
      try {
        wv.current?.loadURL?.(u);
      } catch {
        /* 未就绪 */
      }
    } else {
      patch({ spec: { ...panel.spec, text: u } });
    }
    setDraft(u);
  };

  const openInSystemBrowser = () => {
    const u = draft || target;
    if (u && /^https?:/i.test(u)) {
      window.open(u, '_blank');
    }
  };

  const toHttp = () => {
    const u = err?.url || draft;
    const h = u.replace(/^https:\/\//i, 'http://');
    patch({ spec: { ...panel.spec, text: h } });
    setDraft(h);
  };

  // 支持缩放调节（Ctrl + 滚轮 或 快捷按钮），支持更细腻的微调范围 (20% - 300%)
  const applyZoom = (delta: number) => {
    const next = Math.max(0.2, Math.min(3.0, Math.round((zoomFactor + delta) * 20) / 20));
    setZoomFactor(next);
    try {
      wv.current?.setZoomFactor?.(next);
    } catch {
      /* 未就绪 */
    }
  };

  const resetZoom = () => {
    setZoomFactor(1);
    try {
      wv.current?.setZoomFactor?.(1);
    } catch {
      /* 未就绪 */
    }
  };

  const isHttps = /^https:\/\//i.test(draft || target);
  const isBlank = !target;

  return (
    <div
      className="edge-root"
      data-fit="off"
      onWheel={(e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          applyZoom(e.deltaY < 0 ? 0.1 : -0.1);
        }
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey) {
          if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            applyZoom(0.1);
          } else if (e.key === '-') {
            e.preventDefault();
            applyZoom(-0.1);
          } else if (e.key === '0') {
            e.preventDefault();
            resetZoom();
          }
        }
      }}
    >
      {/* 极简 Edge 工具栏 */}
      <div className="edge-bar">
        <div className="edge-nav">
          <button
            className="edge-btn"
            title={t('后退')}
            disabled={!nav.back}
            onClick={() => call('goBack')}
          >
            <IconBack />
          </button>
          <button
            className="edge-btn"
            title={t('前进')}
            disabled={!nav.fwd}
            onClick={() => call('goForward')}
          >
            <IconForward />
          </button>
          <button
            className="edge-btn"
            title={t('刷新')}
            onClick={() => call('reload')}
          >
            <IconReload />
          </button>
        </div>

        {/* Edge 经典药丸胶囊地址栏 */}
        <div className="edge-pill">
          <div
            className={`edge-security ${isHttps ? 'is-secure' : 'is-warn'}`}
            title={isHttps ? t('连接安全 (HTTPS)') : t('未加密连接 (HTTP)')}
          >
            {isHttps ? <IconLock /> : <IconWarning />}
          </div>
          <input
            ref={bar}
            className="edge-input"
            type="text"
            value={draft}
            placeholder={t('搜索或输入网址')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                navigate(draft);
                bar.current?.blur();
              }
            }}
            onFocus={(e) => e.target.select()}
          />
          {zoomFactor !== 1 && (
            <button
              className="edge-zoom-indicator"
              title={t('点击重置缩放比例至 100% (Ctrl+0)')}
              onClick={resetZoom}
            >
              {Math.round(zoomFactor * 100)}%
            </button>
          )}
        </div>

        {/* 右侧仅保留系统浏览器打开 */}
        <div className="edge-actions">
          <button
            className="edge-btn"
            title={t('在系统默认浏览器中打开')}
            onClick={openInSystemBrowser}
          >
            <IconExternal />
          </button>
        </div>
      </div>

      {/* 细微平滑加载进度条 */}
      {loading && <div className="edge-progress" />}

      {/* 浏览器主体 */}
      <div className="edge-stage">
        {isBlank ? (
          <div className="edge-empty">
            <div className="edge-empty-title">{t('新标签页')}</div>
            <div className="edge-empty-tip">{t('在上方输入网址或搜索关键词')}</div>
          </div>
        ) : (
          <WV
            ref={wv}
            className="edge-web"
            src={target}
            // @ts-expect-error Electron webview tag attributes
            allowpopups="false"
          />
        )}

        {/* 失败兜底 */}
        {err && (
          <div className="edge-err-mask">
            <div className="edge-err-box">
              <div className="edge-err-title">{t('无法访问此页面')}</div>
              <div className="edge-err-msg">
                {err.desc || t('连接被重置或服务未响应')} {err.code ? `(${err.code})` : ''}
              </div>
              <div className="edge-err-url">{err.url || target}</div>
              <div className="edge-err-actions">
                <button className="edge-pill-btn is-main" onClick={() => call('reload')}>
                  {t('重试')}
                </button>
                {(err.url || target).startsWith('https://') && (
                  <button className="edge-pill-btn" onClick={toHttp}>
                    {t('改用 HTTP 打开')}
                  </button>
                )}
                <button className="edge-pill-btn" onClick={openInSystemBrowser}>
                  {t('外部打开')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
