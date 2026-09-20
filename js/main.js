/**
 * FG.Main —— 启动：输入处理、主循环
 */
(() => {
  const canvas = document.getElementById('map-canvas');
  const wrap = document.getElementById('map-wrap');
  const tooltip = document.getElementById('map-tooltip');

  FG.game = new FG.Game();

  let panning = false;
  let dragPlace = null;      // {lastX, lastY} 传送带拖拽放置
  let bpDrag = null;         // {x, y} 蓝图框选锚点

  // ================= 初始化 =================
  function init() {
    FG.Renderer.init(canvas, FG.game);
    FG.Toolbar.init();
    FG.Panels.init();
    FG.Tech.init();
    FG.Topbar.init();
    bindInput();

    window.addEventListener('resize', () => {
      FG.Renderer.resize();
      if (!document.getElementById('tech-tree').classList.contains('hidden')) FG.Tech.render();
    });

    // 首次启动：有存档显示帮助，无存档直接引导新建
    const hasSave = FG.Save.listSlots().some(s => s.exists);
    if (hasSave) FG.Modals.help();
    else FG.Modals.newGame();
  }

  // ================= 输入 =================
  function bindInput() {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const tile = FG.Renderer.screenToTile(mx, my);
      FG.Renderer.setMouseTile(tile.x, tile.y);
      FG.game._lastMouseTile = tile;

      if (panning) {
        const t = FG.Config.TILE * FG.game.camera.zoom;
        FG.game.camera.x -= e.movementX / t;
        FG.game.camera.y -= e.movementY / t;
      }
      if (bpDrag && FG.game.bpMode === 'select') {
        FG.game.bpSelect = { x0: bpDrag.x, y0: bpDrag.y, x1: tile.x, y1: tile.y };
      }
      // 一键流水线预览：智能选位锁定后，仅当鼠标所在原点本身也可放置时才改为跟随鼠标
      //（含矿机的产线只有鼠标悬停到另一处矿脉才会解锁，避免一开始就丢失自动对准）
      if (FG.game.bpMode === 'place' && FG.game.pipelineId && FG.game.bpAnchor) {
        if (FG.Blueprint.validate(FG.game, FG.game.blueprint, tile.x, tile.y).ok) {
          FG.game.bpAnchor = null;
          FG.Events.emit('blueprint:change');
        }
      }
      if (dragPlace) {
        const dx = tile.x - dragPlace.lastX, dy = tile.y - dragPlace.lastY;
        if (dx || dy) {
          FG.game.ghost.dir = dx !== 0 ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
          if (FG.game.placeGhost(tile.x, tile.y)) {
            dragPlace.lastX = tile.x;
            dragPlace.lastY = tile.y;
          }
        }
      }      updateTooltip(e.clientX - wrap.getBoundingClientRect().left, e.clientY - wrap.getBoundingClientRect().top, tile);
    });

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tile = FG.Renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (e.button === 2 || e.button === 1) {
        panning = true;
        return;
      }
      if (e.button === 0) {
        const game = FG.game;
        game._lastMouseTile = tile;
        // 蓝图模式：框选 / 提交施工计划
        if (game.bpMode === 'select') {
          bpDrag = { x: tile.x, y: tile.y };
          game.bpSelect = { x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y };
          return;
        }
        if (game.bpMode === 'place') {
          const o = game.blueprintOrigin(tile.x, tile.y);
          game.submitBlueprintPlanAt(o.x, o.y);
          return;
        }
        if (FG.game.ghost) {
          const gdef = FG.Buildings.byId(FG.game.ghost.type);
          // 传送带与轨道：按住左键拖动连续铺设并自动定向
          if (gdef.beltTier !== undefined || gdef.rail) {
            dragPlace = { lastX: tile.x, lastY: tile.y };
            FG.game.placeGhost(tile.x, tile.y);
          } else {
            FG.game.placeGhost(tile.x, tile.y);
          }
        } else {
          FG.game.selectAt(tile.x, tile.y);
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 2 || e.button === 1) panning = false;
      if (e.button === 0) {
        dragPlace = null;
        // 蓝图框选完成：生成蓝图并进入放置预览（拖拽中途退出模式则放弃）
        if (bpDrag) {
          const r = FG.game.bpSelect;
          bpDrag = null;
          FG.game.bpSelect = null;
          if (r && FG.game.bpMode === 'select') FG.game.captureBlueprint(r.x0, r.y0, r.x1, r.y1);
        }
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (FG.game.bpMode) { FG.game.exitBlueprintMode(); return; }
      if (FG.game.ghost) FG.game.cancelGhost();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cam = FG.game.camera;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const nz = Math.min(2.5, Math.max(0.4, cam.zoom * factor));
      const t = FG.Config.TILE;
      cam.x = (mx / (t * nz)) - (mx / (t * cam.zoom) - cam.x);
      cam.y = (my / (t * nz)) - (my / (t * cam.zoom) - cam.y);
      cam.zoom = nz;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const game = FG.game;
      const techOpen = !document.getElementById('tech-tree').classList.contains('hidden');
      const modalOpen = !!document.querySelector('.modal-mask');

      if (e.key === 'Escape') {
        if (modalOpen) { FG.Modals.closeAll(); return; }
        if (techOpen) { FG.Tech.close(); return; }
        if (game.bpMode) { game.exitBlueprintMode(); return; }
        if (game.ghost) { game.cancelGhost(); return; }
        game.selection = null;
        FG.Events.emit('selection:change');
        return;
      }
      if (modalOpen || techOpen) return;

      switch (e.key) {
        case 'r': case 'R':
          if (game.bpMode === 'place') game.rotateBlueprint();
          else if (game.ghost) {
            // 铁路信号：R 旋转时实时校验朝向（必须正对轨道），无效朝向自动跳过
            const gd = FG.Buildings.byId(game.ghost.type);
            if (gd.signal) {
              for (let i = 0; i < 4; i++) {
                game.ghost.dir = (game.ghost.dir + 1) % 4;
                const t = game._lastMouseTile;
                if (!t || game.canPlaceSignalDir(t.x, t.y, game.ghost.dir)) break;
              }
            } else {
              game.rotateGhost();
            }
          }
          else if (game.selection && (game.selection.def
                    && (game.selection.def.beltTier !== undefined || game.selection.def.inserterTier !== undefined
                        || game.selection.def.rail || game.selection.def.signal))) {
            game.selection.dir = (game.selection.dir + 1) % 4;
            if (game.selection.def.signal || game.selection.def.rail) game.railway.markDirty();
          }
          break;
        case 'f': case 'F':
          if (game.bpMode === 'place' && game.pipelineId) game.refindPipelineAnchor();
          break;
        case 'p': case 'P':
          if (game.state === 'playing') FG.Modals.pipelines();
          break;
        case 'b': case 'B':
          game.toggleBlueprintMode();
          break;
        case 'Delete': case 'Backspace':
          if (game.selection) game.removeBuilding(game.selection);
          break;        case ' ':
          e.preventDefault();
          game.togglePause();
          break;
        case 't': case 'T': FG.Tech.open(); break;
        case 's': case 'S': game.showStatus = !game.showStatus; break;
        case '1': game.setSpeed(0.5); break;
        case '2': game.setSpeed(1); break;
        case '3': game.setSpeed(2); break;
        case '4': game.setSpeed(4); break;
      }
    });
  }

  // ================= 悬浮提示 =================
  function updateTooltip(px, py, tile) {
    const game = FG.game;
    const modalOpen = !!document.querySelector('.modal-mask');
    const techOpen = !document.getElementById('tech-tree').classList.contains('hidden');
    if (modalOpen || techOpen || game.bpMode) { tooltip.classList.add('hidden'); return; }
    const m = game.map;
    if (!m || !m.inBounds(tile.x, tile.y)) { tooltip.classList.add('hidden'); return; }

    const b = m.buildingAt(tile.x, tile.y);
    const train = !b ? game.railway.trainAtTile(tile.x, tile.y) : null;
    const pile = !b && !train ? m.pileAt(tile.x, tile.y) : null;
    const planEntry = !b && game.construction ? game.construction.entryAt(tile.x, tile.y) : null;
    let html = '';
    if (b) {
      const st = { working: '生产中/流动', starving: '缺料', blocked: '堵塞', idle: '闲置', empty: '枯竭', noPath: '断路停车' };
      html += `<div class="tt-title">${b.def.name}</div>`;
      html += `<div class="tt-row">状态：<b>${st[b.status] || b.status}</b></div>`;
      if (b.def.station) {
        html += `<div class="tt-row">站名：<b>${b.stationName || '未命名'}</b>（${b.stationId || '-'}）</div>`;
        const occ = game.railway.dwellingTrainAt(b.x, b.y);
        html += `<div class="tt-row">停靠：<b>${occ ? occ.id : '无'}</b>${occ ? ' · 机械臂可装卸' : ''}</div>`;
      }
      if (b.def.signal) {
        const ahead = game.railway.signalAhead(b);
        if (!ahead.valid) html += `<div class="tt-row" style="color:var(--red)">朝向无效（前方须有轨道）</div>`;
        else html += `<div class="tt-row">信号：<b style="color:${ahead.train ? 'var(--red)' : 'var(--green)'}">${ahead.train ? '红灯（分区占用）' : '绿灯'}</b></div>`;
      }
      if (b.def.rail) {
        const deg = m.railDegree(b.x, b.y);
        html += `<div class="tt-row">轨道${deg >= 3 ? ' · <b>交叉/岔路节点</b>（独立闭塞）' : deg === 1 ? ' · 尽头' : ''}</div>`;
        if (game.railway.trainAtTile(b.x, b.y)) html += `<div class="tt-row">列车占用：<b>${game.railway.trainAtTile(b.x, b.y).id}</b></div>`;
      }
      if (b.recipe) {
        const r = FG.Recipes.byId(b.recipe);
        const p = Math.min(1, b.progress / r.time);
        html += `<div class="tt-row">${r.name} <b>${(p * 100).toFixed(0)}%</b></div>`;
      }
      if (b.def.beltTier !== undefined) {
        let merge = 0;
        for (const side of [2, 3]) {
          const sv = FG.Map.beltSideVec(b.dir, side);
          const nb = m.buildingAt(b.x + sv.x, b.y + sv.y);
          if (nb && nb.def.beltTier !== undefined && FG.Map.beltFeedsInto(nb, b)) merge++;
        }
        html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · ${b.items.length}/${FG.Config.BELT_CAP}${merge ? ` · ${merge} 路汇入` : ''}</div>`;
      }
      if (b.def.inserterTier !== undefined) html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · 筛选 <b>${b.filter ? FG.Items.byId(b.filter).name : '任意'}</b>${b.demandMode ? ' · 按需' : ''}</div>`;
      if (b.type === 'pipe') html += `<div class="tt-row">流体 <b>${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</b></div>`;
      if (b.type === 'miner' && b.oreType) html += `<div class="tt-row">${FG.Items.byId(b.oreType).name} <b>${FG.Utils.fmtNum(m.amountAt(b.x, b.y))}</b></div>`;
    } else if (train) {
      const st = { working: '行驶中', blocked: '红灯/堵站等待', idle: '无运输计划', noPath: '断路停车' };
      html += `<div class="tt-title">🚃 列车 ${train.id}</div>`;
      html += `<div class="tt-row">状态：<b>${st[train.status] || train.status}</b></div>`;
      const dest = train.destStationId ? game.railway.stationById(train.destStationId) : null;
      html += `<div class="tt-row">目的地：<b>${dest ? dest.stationName : '—'}</b></div>`;
      const cargo = train.cargo.filter(s => s.count > 0);
      if (cargo.length) {
        for (const s of cargo.slice(0, 3)) html += `<div class="tt-row">${FG.Items.byId(s.type).name} <b>×${s.count}</b></div>`;
      } else {
        html += `<div class="tt-row">货厢：空</div>`;
      }
      if (train.mode === 'dwell') html += `<div class="tt-row" style="color:var(--green)">停站装卸中（机械臂可访问）</div>`;
    } else if (pile) {
      html += `<div class="tt-title">地面物料</div>`;
      for (const s of pile.slice(0, 6)) html += `<div class="tt-row">${FG.Items.byId(s.type).name} <b>×${FG.Utils.fmtNum(s.count)}</b></div>`;
      html += `<div class="tt-row" style="margin-top:3px">在此格放置建筑可回收</div>`;
    } else if (planEntry) {
      const p = planEntry.plan, e = planEntry.entry;
      const def = FG.Buildings.byId(e.type);
      const cost = FG.Buildings.costOf(e.type);
      html += `<div class="tt-title">🏗 ${p.name}</div>`;
      html += `<div class="tt-row">待建：<b>${def.name}</b>（${FG.Utils.dirName(e.dir)}）</div>`;
      const stTxt = p.paused ? '已暂停（预留已返还）'
        : p.blocked ? '等待前置计划'
        : p.waiting ? '缺料等待（可建部分先行）'
        : '施工中';
      html += `<div class="tt-row">状态：<b>${stTxt}</b></div>`;
      const parts = Object.keys(cost).map(k =>
        `${FG.Items.byId(k).name} ${Math.min(e.stock[k] || 0, cost[k])}/${cost[k]}`);
      if (parts.length) html += `<div class="tt-row">建材：${parts.join(' · ')}</div>`;
    } else {
      const ore = m.ores[tile.y][tile.x];
      if (ore) {
        html += `<div class="tt-title">${FG.Items.byId(ore.type).name}</div>`;
        html += `<div class="tt-row">储量 <b>${FG.Utils.fmtNum(ore.amount)}</b></div>`;
      } else if (m.isOil(tile.x, tile.y)) {
        html += `<div class="tt-title">油田</div><div class="tt-row">放置抽油机抽取原油</div>`;
      } else if (m.isWater(tile.x, tile.y)) {
        html += `<div class="tt-title">水域</div><div class="tt-row">放置水泵取水</div>`;
      } else {
        tooltip.classList.add('hidden');
        return;
      }
    }
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
    tooltip.style.left = Math.min(px + 14, wrap.clientWidth - 250) + 'px';
    tooltip.style.top = Math.min(py + 14, wrap.clientHeight - 120) + 'px';
  }

  // ================= 主循环 =================
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    FG.game.update(dt);
    FG.Renderer.render();
    requestAnimationFrame(loop);
  }

  init();
  requestAnimationFrame(loop);
})();
