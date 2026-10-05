import React, { useEffect, useState } from 'react';
import { api, type CatalogProvider } from '../core/api';
import { t } from '../core/i18n';

/**
 * 对话框上的模型选择。
 *
 * **按会话选**：换模型只动这个面板，同一个窗口里别的会话不受影响。
 *
 * 模型清单直接来自 **harness 的提供方配置**（`settings.yaml` 的 providers +
 * `.credentials.yaml` 的密钥），按提供方分组；这里只能选，不能填、不能改 ——
 * 想加提供方或换密钥，去 harness 的模型设置里改。
 *
 * 列表上面那一排是**思考水平**，就四档（off / low / medium / high），按会话存。
 * 各家 API 的刻度不一样 —— 这里只定四档，发请求时按提供方映射到各自的字段；
 * 提供方不认那个字段时，发请求那边会把它摘掉重发，不会因此报错。
 */
/**
 * 思考档位：前面一个 `auto` 是**不限制**（默认，一个思考参数都不发，
 * 由接口按自己的脾气决定），后面四档才是明确要求（off / low / medium / high）。
 * 名字直接用 API 那套写法。
 *
 * 存的是空串 = 没设过 = auto；显示上 auto 那一格亮起来，
 * **不要把它跟 off 混成一格** —— "不设"和"关掉"是两件事。
 */
const THINKS: { v: string; label: string; hint: string }[] = [
  { v: '', label: 'auto', hint: t('不限制（默认）：一个思考参数都不发，随接口自己的默认行为') },
  { v: 'off', label: 'off', hint: t('关掉思考：按提供方的方式要求它别想') },
  { v: 'low', label: 'low', hint: t('少想一点：更快、更省') },
  // 显示成 mid：`medium` 六个字母，五格均分后每格才 48px，它是唯一撑不住的词。
  // 内部值仍然是 medium（store / chat-core 那套映射按这个认），只缩显示。
  { v: 'medium', label: 'mid', hint: t('标准思考量（medium）') },
  { v: 'high', label: 'high', hint: t('想得更深：更准，但更慢也更贵') },
];

export function ModelList({ panelId, onClose }: { panelId: string; onClose(): void }) {
  const [now, setNow] = useState({ pick: '', provider: '', name: '', hasKey: true, think: '' });
  const [groups, setGroups] = useState<CatalogProvider[]>([]);
  const [busy, setBusy] = useState(true);

  const load = async (force = false) => {
    setBusy(true);
    const me = await api.model.get(panelId);
    const cat = await api.model.catalog();
    setNow({ ...me, think: me.think ?? '' });
    setGroups(cat);
    setBusy(false);
  };

  useEffect(() => {
    void load();
  }, [panelId]);

  const pick = async (value: string) => {
    await api.model.set(panelId, { pick: value });
    onClose();
  };

  /**
   * 思考水平**不关浮层**：这一档本来就是拿来拨着试的，
   * 而且只带 think 过去，不会碰已经选好的模型。
   */
  const setThink = async (level: string) => {
    const next = await api.model.set(panelId, { think: level });
    setNow((n) => ({ ...n, think: next.think ?? '' }));
  };

  return (
    <div className="model-list" onMouseLeave={onClose}>
      <div className="ml-head">
        <span>{t('这个会话用哪个模型')}</span>
        <button onClick={() => void load(true)} disabled={busy}>
          {t('刷新')}
        </button>
      </div>

      <div className="ml-think">
        <span className="ml-think-label">{t('思考水平')}</span>
        <div className="ml-think-opts">
          {THINKS.map((item) => (
            <button
              key={item.v}
              className={`ml-think-btn${(now.think ?? '') === item.v ? ' is-on' : ''}`}
              title={item.hint}
              onClick={() => void setThink(item.v)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {!now.hasKey && <div className="ml-note">{t('当前这个提供方还没配密钥，发不出去。')}</div>}

      <div className="ml-items">
        {busy && <div className="ml-note">{t('正在读取提供方…')}</div>}
        {!busy && groups.length === 0 && <div className="ml-note">{t('还没有可用的提供方。')}</div>}
        {groups.map((g) => (
          <div className="ml-group" key={g.key}>
            <div className="ml-group-head">
              <span className="ml-group-name">{g.label}</span>
              <span className={`ml-key${g.hasKey ? '' : ' is-missing'}`}>{g.hasKey ? t('已配密钥') : t('没密钥')}</span>
            </div>
            {g.models.map((m) => {
              const value = `${g.key}::${m.id}`;
              return (
                <button key={value} className={`ml-row${value === now.pick ? ' is-on' : ''}`} onClick={() => void pick(value)}>
                  <span className="ml-dot" />
                  <span className="ml-name">{m.name}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="ml-foot">
        <button onClick={() => void pick('')} title={t('跟随默认模型')}>
          {t('跟默认')}
        </button>
        <span className="ml-path">{t('在设置里加提供方')}</span>
      </div>
    </div>
  );
}
