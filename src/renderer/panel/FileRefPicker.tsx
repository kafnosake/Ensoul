import React, { useEffect, useState } from 'react';
import { api } from '../core/api';
import { t } from '../core/i18n';

/** 引用工作区里的文件：插一个 @路径 进输入框，发出去时主进程会把文件内容带上 */
export function FileRefPicker({ onPick, onClose }: { onPick(path: string): void; onClose(): void }) {
  const [dir, setDir] = useState('.');
  const [entries, setEntries] = useState<{ name: string; dir: boolean; path: string; size: number }[]>([]);

  useEffect(() => {
    void api.fs.list(dir).then(setEntries);
  }, [dir]);

  return (
    <div className="ref-picker" onMouseLeave={onClose}>
      <div className="rp-head">
        {dir === '.' ? (
          <span>{t('工作区')}</span>
        ) : (
          <button
            onClick={() => {
              const up = dir.split('/').slice(0, -1).join('/');
              setDir(up || '.');
            }}
          >
            ↑ 上一层
          </button>
        )}
        <span className="rp-dir">{dir === '.' ? '' : dir}</span>
      </div>
      <div className="rp-list">
        {entries.slice(0, 200).map((e) => (
          <button
            key={e.path}
            className="rp-row"
            onClick={() => {
              if (e.dir) setDir(e.path);
              else {
                onPick(e.path);
                onClose();
              }
            }}
          >
            <span className="rp-icon">{e.dir ? '▸' : '·'}</span>
            <span className="rp-name">{e.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
