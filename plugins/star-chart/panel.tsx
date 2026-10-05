import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';
import './panel.css';

interface StarNode {
  id: string;
  name: string;
  dept?: string;
  avatar?: string;
  panelId?: string;
  outDegree: number;
  inDegree: number;
  radius: number;
  status: 'working' | 'waiting' | 'idle';
  statusText: string;
  taskSnippet?: string;
  lastSpokeAt: number; // 最后发言/活动时间戳
  isExiled: boolean;   // 4小时以上没说话：打入边缘外圈
  x: number;
  y: number;
  vx: number;
  vy: number;
  attachedTo: string | null;
  attachAngle: number;
  attachDist: number;
  attachSpeed: number;
}

interface StarLink {
  id: string;
  sourceId: string;
  targetId: string;
  active: boolean; // 任务进行中（吞吐流动光流）
  status: 'pending' | 'done' | 'cancelled';
  taskTitle?: string;
  isAttached: boolean; // 末端贴合吸附
  lastActiveAt: number; // 派单/联系时间
}

interface Particle {
  linkId: string;
  sourceId: string;
  targetId: string;
  progress: number;
  speed: number;
}

const ESCHAT_FILE = '.ensoul/state/eschat.json';
const INBOX_FILE = '.ensoul/state/dispatch.inbox.json';
const TODO_FILE = '.ensoul/state/todo.json';

// 4小时阈值（毫秒）
const FOUR_HOURS = 4 * 60 * 60 * 1000;

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export default function StarChartPanel(props: PanelFaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const scaleRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const startPanRef = useRef({ x: 0, y: 0 });

  const nodesRef = useRef<Map<string, StarNode>>(new Map());
  const linksRef = useRef<StarLink[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const hoveredNodeRef = useRef<StarNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<StarNode | null>(null);

  // 1. 数据轮询与星系构建
  useEffect(() => {
    let unmounted = false;

    async function loadData() {
      try {
        const windowApi = (window as any).ensoul;
        const fs = props.fs || windowApi?.fs;
        if (!fs) return;

        const [eschatRaw, inboxRaw, todoRaw, wsState] = await Promise.all([
          fs.read(ESCHAT_FILE).catch(() => ''),
          fs.read(INBOX_FILE).catch(() => ''),
          fs.read(TODO_FILE).catch(() => ''),
          windowApi?.workspace?.getPanels ? windowApi.workspace.getPanels().catch(() => null) : Promise.resolve(null),
        ]);

        if (unmounted) return;

        const eschatData = safeParse<any>(eschatRaw, { contacts: [] });
        const inboxData = safeParse<any>(inboxRaw, { entries: [] });
        const todoData = safeParse<any>(todoRaw, {});
        const todoPanels = todoData.panels || {};

        const contacts: any[] = eschatData.contacts || [];
        const entries: any[] = inboxData.entries || [];
        const runningPanels: string[] = wsState?.runningPanels || [];

        const nextNodes = new Map<string, StarNode>();
        const prevNodes = nodesRef.current;

        // 登记已有会话面板
        const panelList = Array.isArray(wsState) ? wsState : (wsState?.panels || []);
        if (Array.isArray(panelList)) {
          panelList.forEach((p: any) => {
            if (!p.id || p.kind === 'star-chart') return;
            const existing = prevNodes.get(p.id);
            const title = p.title || t('普通会话');

            nextNodes.set(p.id, {
              id: p.id,
              name: title,
              panelId: p.id,
              outDegree: 0,
              inDegree: 0,
              radius: 7,
              status: 'idle',
              statusText: t('待命'),
              lastSpokeAt: 0,
              isExiled: false,
              x: existing ? existing.x : (Math.random() - 0.5) * 500,
              y: existing ? existing.y : (Math.random() - 0.5) * 400,
              vx: 0,
              vy: 0,
              attachedTo: null,
              attachAngle: Math.random() * Math.PI * 2,
              attachDist: 26 + Math.random() * 8,
              attachSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.015 + Math.random() * 0.01),
            });
          });
        }

        const now = Date.now();
        // 登记团队通讯录中的员工
        contacts.forEach((c: any) => {
          if (!c.name) return;
          const id = c.panelId || `agent-${c.name}`;
          const existing = prevNodes.get(id);
          nextNodes.set(id, {
            id,
            name: c.name,
            dept: c.dept,
            avatar: c.avatar,
            panelId: c.panelId,
            outDegree: 0,
            inDegree: 0,
            radius: 15,
            status: 'idle',
            statusText: t('待命'),
            lastSpokeAt: c.at || c.lastActive || 0,
            isExiled: !c.at || (now - c.at > FOUR_HOURS),
            x: existing ? existing.x : (Math.random() - 0.5) * 500,
            y: existing ? existing.y : (Math.random() - 0.5) * 400,
            vx: 0,
            vy: 0,
            attachedTo: null,
            attachAngle: Math.random() * Math.PI * 2,
            attachDist: 38 + Math.random() * 8,
            attachSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.015 + Math.random() * 0.01),
          });
        });
        // 根据派单队列构造父子连线与链路
        const linkMap = new Map<string, StarLink>();

        entries.forEach((entry: any) => {
          const fromName = entry.fromName || entry.fromPanel;
          const toName = entry.holderName || entry.holder;
          if (!fromName || !toName) return;

          // 规则1：4小时以上没联系的就直接断开（不生成连线）
          const linkTime = entry.doneAt || entry.at || 0;
          const isLinkExpired = entry.status === 'done' && (!linkTime || (now - linkTime > FOUR_HOURS));
          if (isLinkExpired) return;

          let sId: string | null = null;
          let tId: string | null = null;

          nextNodes.forEach((n) => {
            if (fromName === n.id || fromName === n.panelId || fromName.includes(n.name)) sId = n.id;
            if (toName === n.id || toName === n.panelId || toName.includes(n.name)) tId = n.id;
          });

          // 如果发包源不在已有列表中，独立作为主星加入
          if (!sId && fromName) {
            sId = `initiator-${fromName}`;
            const existing = prevNodes.get(sId);
            nextNodes.set(sId, {
              id: sId,
              name: fromName.slice(0, 16),
              outDegree: 0,
              inDegree: 0,
              radius: 7,
              status: 'idle',
              statusText: t('发包方'),
              x: existing ? existing.x : (Math.random() - 0.5) * 400,
              y: existing ? existing.y : (Math.random() - 0.5) * 300,
              vx: 0,
              vy: 0,
              attachedTo: null,
              attachAngle: 0,
              attachDist: 0,
              attachSpeed: 0,
            });
          }

          if (sId && tId && sId !== tId) {
            const lKey = `${sId}->${tId}`;
            const isActive = entry.status === 'pending';
            const exist = linkMap.get(lKey);

            if (exist) {
              if (isActive) exist.active = true;
            } else {
              linkMap.set(lKey, {
                id: lKey,
                sourceId: sId,
                targetId: tId,
                active: isActive,
                status: entry.status || 'pending',
                taskTitle: entry.task ? entry.task.slice(0, 40) : undefined,
                isAttached: false,
              });
            }
          }
        });

        // 计算拓扑出入度：完全根据真实的派发流向决定星体权重与大小（发出的多 = 越高级 = 越大）
        linkMap.forEach((l) => {
          const s = nextNodes.get(l.sourceId);
          const t = nextNodes.get(l.targetId);
          if (s) s.outDegree += 1;
          if (t) t.inDegree += 1;
        });

        // 规则2：4小时以上没说话/没活动的星体，标记为 isExiled（扔远点）
        nextNodes.forEach((node) => {
          node.radius = Math.min(22, 11 + Math.sqrt(node.outDegree) * 4);
          // 4小时没说话或从未发言，且没有正在进行的任务：直接流放
          if (node.status === 'idle' && (!node.lastSpokeAt || now - node.lastSpokeAt > FOUR_HOURS)) {
            node.isExiled = true;
          } else {
            node.isExiled = false;
          }
        });

        // 刷新节点真实运行状态
        nextNodes.forEach((node) => {
          const isRunning = runningPanels.includes(node.panelId || '');
          const activeEntry = entries.find(
            (e: any) =>
              (e.holderName?.includes(node.name) || e.holder === node.panelId) &&
              e.status === 'pending'
          );

          if (isRunning) {
            node.status = 'working';
            node.statusText = t('执行中');
          } else if (activeEntry) {
            node.status = 'working';
            node.statusText = activeEntry.task ? activeEntry.task.slice(0, 24) : t('承接任务中');
            node.taskSnippet = activeEntry.task;
          } else {
            const panelTodo = node.panelId ? todoPanels[node.panelId] : null;
            const inProg = panelTodo?.items?.find((it: any) => it.status === 'in_progress');
            if (inProg) {
              node.status = 'waiting';
              node.statusText = inProg.content;
              node.taskSnippet = inProg.content;
            } else {
              node.status = 'idle';
              node.statusText = t('待命');
            }
          }
        });

        // 核心规则：收包单位如果“没有下一级单位”且“任务正在执行中”，吸附在上一级边上摇曳
        // 任务完成后（status !== 'pending'）解除吸附，但保留连线
        const outgoingMap = new Map<string, number>();
        linkMap.forEach((l) => {
          outgoingMap.set(l.sourceId, (outgoingMap.get(l.sourceId) || 0) + 1);
        });

        linkMap.forEach((link) => {
          const target = nextNodes.get(link.targetId);
          if (!target) return;

          const hasNextChild = (outgoingMap.get(link.targetId) || 0) > 0;
          if (link.active && !hasNextChild) {
            link.isAttached = true;
            target.attachedTo = link.sourceId;
          } else {
            link.isAttached = false;
            if (target.attachedTo === link.sourceId) {
              target.attachedTo = null;
            }
          }
        });

        nodesRef.current = nextNodes;
        linksRef.current = Array.from(linkMap.values());
      } catch (err) {
        // 静默保护
      }
    }

    loadData();
    const timer = setInterval(loadData, 2000);
    return () => {
      unmounted = true;
      clearInterval(timer);
    };
  }, [props.fs]);

  // 2. 动画渲染与物理粒子循环 (无外围大UI，纯净全屏画布)
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = rect.height;

      if (w === 0 || h === 0) {
        animId = requestAnimationFrame(render);
        return;
      }

      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // 读取当前主题变量，与界面完全一体同色
      const style = getComputedStyle(canvas);
      const themeBg = style.getPropertyValue('--bg').trim() || '#1e1e20';
      const themeText = style.getPropertyValue('--text').trim() || '#d0d0d2';
      const themeAccent = style.getPropertyValue('--accent').trim() || '#5b8cff';

      // 区分嵌入状态与浮窗状态：
      // 嵌入模式：透明背景（清除画布），与宿主停靠槽背景浑然天成；
      // 浮窗模式：微透主题底色，保证悬浮在其他窗口上方时的层次与阅读体验。
      const isFloating = !!props.panel.float;
      ctx.clearRect(0, 0, w, h);
      if (isFloating) {
        ctx.fillStyle = themeBg;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.save();
      // 将原点置于画布正中心
      const curPan = panRef.current;
      const curScale = scaleRef.current;
      ctx.translate(w / 2 + curPan.x, h / 2 + curPan.y);
      ctx.scale(curScale, curScale);

      const nodes = nodesRef.current;
      const links = linksRef.current;

      // 物理模拟计算
      nodes.forEach((node) => {
        if (node.attachedTo && nodes.has(node.attachedTo)) {
          // 吸附状态：贴在上一级边上摇曳公转
          const parent = nodes.get(node.attachedTo)!;
          node.attachAngle += node.attachSpeed;
          const targetX = parent.x + Math.cos(node.attachAngle) * (parent.radius + node.attachDist);
          const targetY = parent.y + Math.sin(node.attachAngle) * (parent.radius + node.attachDist);
          node.x += (targetX - node.x) * 0.15;
          node.y += (targetY - node.y) * 0.15;
        } else {
          // 自由星体微排斥，避免重叠
          nodes.forEach((other) => {
            if (other.id === node.id || other.attachedTo === node.id) return;
            const dx = node.x - other.x;
            const dy = node.y - other.y;
            const dist = Math.hypot(dx, dy) || 1;
            const minDist = (node.radius + other.radius) * 4.2;
            if (dist < minDist) {
              const force = ((minDist - dist) / minDist) * 0.5;
              node.vx += (dx / dist) * force;
              node.vy += (dy / dist) * force;
            }
          });

          // 向中心轻微引力
          node.vx -= node.x * 0.0003;
          node.vy -= node.y * 0.0003;

          node.x += node.vx;
          node.y += node.vy;
          node.vx *= 0.9;
          node.vy *= 0.9;
        }
      });

      // 粒子生成（吞吐光流）
      links.forEach((link) => {
        if (!link.active) return;
        if (Math.random() < 0.35) {
          particlesRef.current.push({
            linkId: link.id,
            sourceId: link.sourceId,
            targetId: link.targetId,
            progress: 0,
            speed: 0.018 + Math.random() * 0.012,
          });
        }
      });

      // 绘制星轨连线
      links.forEach((link) => {
        const s = nodes.get(link.sourceId);
        const t = nodes.get(link.targetId);
        if (!s || !t) return;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        if (link.active) {
          // 活跃吞吐连线：主题流光通道
          ctx.strokeStyle = themeAccent;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // 外圈柔和晕光
          ctx.strokeStyle = themeAccent;
          ctx.globalAlpha = 0.15;
          ctx.lineWidth = 4;
          ctx.stroke();
        } else {
          // 任务完成解除吸附后保留的连线：静谧微星轨
          ctx.strokeStyle = 'rgba(120, 130, 145, 0.28)';
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      });

      // 绘制光流粒子
      particlesRef.current = particlesRef.current.filter((p) => {
        const s = nodes.get(p.sourceId);
        const t = nodes.get(p.targetId);
        if (!s || !t) return false;

        p.progress += p.speed;
        if (p.progress >= 1) return false;

        const px = s.x + (t.x - s.x) * p.progress;
        const py = s.y + (t.y - s.y) * p.progress;

        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.9;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = themeAccent;
        ctx.globalAlpha = 0.35;
        ctx.fill();

        return true;
      });

      // 绘制星体
      nodes.forEach((node) => {
        const r = node.radius;
        const isHovered = hoveredNodeRef.current?.id === node.id;
        const isWorking = node.status === 'working';

        // 1. 光晕（仅在活跃或鼠标悬停时轻微绽放，绝不泛白糊住画面）
        if (isHovered || isWorking) {
          const glowRadius = r * 1.8;
          const glow = ctx.createRadialGradient(node.x, node.y, r * 0.8, node.x, node.y, glowRadius);
          if (isWorking) {
            glow.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
            glow.addColorStop(1, 'rgba(56, 189, 248, 0)');
          } else {
            glow.addColorStop(0, 'rgba(255, 235, 180, 0.25)');
            glow.addColorStop(1, 'rgba(255, 235, 180, 0)');
          }
          ctx.beginPath();
          ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
          ctx.fillStyle = glow;
          ctx.fill();
        }

        // 核心实体：带一层光亮描边的角色头像
        // 描边外圈比头像内圆略大半圈，且使用等比居中裁切（cover），彻底避免头像被边框压住/切角
        const strokeW = isWorking ? 2.2 : (node.outDegree > 0 ? 2 : 1.6);
        const innerR = Math.max(1, r - strokeW * 0.4);

        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, innerR, 0, Math.PI * 2);
        ctx.clip();

        let hasAvatarDrawn = false;
        if (node.avatar) {
          let img = imgCacheRef.current.get(node.avatar);
          if (!img) {
            img = new Image();
            img.src = node.avatar;
            img.onload = () => {};
            imgCacheRef.current.set(node.avatar, img);
          }
          if (img.complete && img.naturalWidth > 0) {
            // 等比居中 cover 裁剪，防止比例失真或边缘裁切变形
            const nw = img.naturalWidth;
            const nh = img.naturalHeight;
            const minSide = Math.min(nw, nh);
            const sx = (nw - minSide) / 2;
            const sy = (nh - minSide) / 2;
            ctx.drawImage(img, sx, sy, minSide, minSide, node.x - innerR, node.y - innerR, innerR * 2, innerR * 2);
            hasAvatarDrawn = true;
          }
        }

        if (!hasAvatarDrawn) {
          // 备用：首字头像质感底
          ctx.fillStyle = node.outDegree > 0 ? '#333b47' : '#252a32';
          ctx.fillRect(node.x - innerR, node.y - innerR, innerR * 2, innerR * 2);
          ctx.font = `600 ${Math.max(9, innerR * 0.95)}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(node.name.slice(0, 1), node.x, node.y + 1);
        }
        ctx.restore();

        // 外层光亮描边 (Bright Ring Stroke) —— 完美包覆在头像外侧
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        if (isWorking) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = strokeW;
        } else if (node.outDegree > 0) {
          ctx.strokeStyle = 'rgba(255, 235, 180, 0.95)';
          ctx.lineWidth = strokeW;
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.lineWidth = strokeW;
        }
        ctx.globalAlpha = node.isExiled ? 0.35 : (isHovered ? 1 : 0.95);
        ctx.stroke();

        // 标签文字（如同参考图一样精致贴在星体下方）
        ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = isHovered ? '#ffffff' : themeText;
        ctx.globalAlpha = node.isExiled ? 0.3 : (isHovered ? 1 : 0.85);
        ctx.fillText(node.name, node.x, node.y + r + 13);
      });

      ctx.restore();
      ctx.restore();

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, []); // 仅依赖空数组启动常驻高刷 RAF，平移与缩放直接取 ref，绝不被闭包中断！

  // 鼠标交互
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    scaleRef.current = Math.min(3, Math.max(0.3, scaleRef.current * zoomFactor));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isPanningRef.current = true;
    startPanRef.current = {
      x: e.clientX - panRef.current.x,
      y: e.clientY - panRef.current.y,
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanningRef.current) {
      panRef.current = {
        x: e.clientX - startPanRef.current.x,
        y: e.clientY - startPanRef.current.y,
      };
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const originX = rect.width / 2 + panRef.current.x;
    const originY = rect.height / 2 + panRef.current.y;
    const simX = (mouseX - originX) / scaleRef.current;
    const simY = (mouseY - originY) / scaleRef.current;

    let found: StarNode | null = null;
    nodesRef.current.forEach((n) => {
      const dist = Math.hypot(n.x - simX, n.y - simY);
      if (dist <= n.radius + 6) found = n;
    });

    hoveredNodeRef.current = found;
    setHoveredNode(found);
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (hoveredNodeRef.current?.panelId) {
      const api = (window as any).ensoul;
      api?.workspace?.focus?.(hoveredNodeRef.current.panelId);
    }
  }, []);

  const isFloating = !!props.panel.float;

  return (
    <div
      ref={containerRef}
      className={`star-chart-container${isFloating ? ' is-floating' : ''}`}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      <canvas ref={canvasRef} className="sc-canvas-fullscreen" />

      {/* 极简悬停微详情 */}
      {hoveredNode && (
        <div className="sc-cosmic-tooltip">
          <div className="sc-tip-title">
            <span className={`sc-tip-dot ${hoveredNode.status}`} />
            {hoveredNode.name}
          </div>
          <div className="sc-tip-status">{hoveredNode.statusText}</div>
          {hoveredNode.taskSnippet && (
            <div className="sc-tip-task">{hoveredNode.taskSnippet}</div>
          )}
        </div>
      )}
    </div>
  );
}
