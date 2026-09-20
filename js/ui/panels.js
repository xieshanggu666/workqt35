/**
 * FG.Panels —— 右侧面板：信息 / 统计 / 日志
 */
FG.Panels = (() => {
  let activeTab = 'info';
  let chartItems = [];
  let lastRefresh = 0;

  const tabsEl = () => document.getElementById('sp-tabs');
  const bodyEl = () => document.getElementById('sp-body');

  const STATUS_NAMES = { working: '生产中', starving: '缺料', blocked: '堵塞', idle: '闲置', empty: '枯竭' };

  function init() {
    for (const b of tabsEl().querySelectorAll('button')) {
      b.onclick = () => {
        activeTab = b.dataset.tab;
        tabsEl().querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        render();
      };
    }
    FG.Events.on('sim:tick', () => {
      const now = performance.now();
      if (now - lastRefresh > 150) { lastRefresh = now; render(); }
    });
    FG.Events.on('selection:change', () => { render(); });
    FG.Events.on('recipe:change', () => { render(); });
    FG.Events.on('construction:change', () => { if (activeTab === 'build') render(); });
    FG.Events.on('blueprint:change', () => { if (activeTab === 'build') render(); });
    FG.Events.on('message', () => { if (activeTab === 'log') render(); });
  }

  function render() {
    if (!FG.game || FG.game.state !== 'playing') return;
    if (activeTab === 'info') renderInfo();
    else if (activeTab === 'stats') renderStats();
    else if (activeTab === 'build') renderBuild();
    else if (activeTab === 'log') renderLog();
    bindActions();
  }

  // ================= 信息 =================
  function renderInfo() {
    const game = FG.game;
    const sel = game.selection;
    let html = '';
    if (!sel) {
      html += `<div class="panel-sec"><h4>工厂概况</h4>
        <div class="info-grid">
          <div class="k">建筑数</div><div class="v">${game.totalBuildings()}</div>
          <div class="k">已研究</div><div class="v">${game.research.completed.size} / ${FG.Research.list().length}</div>
          <div class="k">列车</div><div class="v">${game.railway.trains.length}</div>
          <div class="k">游戏时间</div><div class="v">${FG.Utils.fmtTime(game.playTime)}</div>
        </div>
        <div style="color:var(--text-dim);font-size:11px;margin-top:8px;line-height:1.6">
          点击地图上的建筑查看详情。<br>
          拖动右键平移视野，滚轮缩放。<br>
          铺设轨道 → 放火车站与信号 → 在轨道上放列车 →<br>
          选中列车设置运输计划，用机械臂在停站列车旁装卸货物。
        </div></div>`;
    } else if (sel.type === 'train') {
      html += trainInfo(sel);
    } else {
      html += buildingInfo(sel);
    }
    bodyEl().innerHTML = html;
  }

  function buildingInfo(b) {
    const game = FG.game;
    let h = `<div class="panel-sec"><h4>${b.def.name}</h4>
      <div class="info-grid">
        <div class="k">状态</div><div class="v status-${b.status}">${STATUS_NAMES[b.status] || b.status}</div>
        <div class="k">坐标</div><div class="v">(${b.x}, ${b.y})</div>
        ${b.def.beltTier !== undefined ? `<div class="k">方向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">方向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>` : ''}
        ${b.def.beltTier !== undefined ? `<div class="k">物品</div><div class="v">${b.items.length}/${FG.Config.BELT_CAP}</div>` : ''}
        ${b.type === 'pipe' ? `<div class="k">流体</div><div class="v">${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">手持</div><div class="v">${b.held ? FG.Items.byId(b.held.type).name : '空'}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">筛选</div><div class="v">${b.filter ? FG.Items.byId(b.filter).name : '任意'}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">按需供给</div><div class="v">${b.demandMode ? '开' : '关'}</div>` : ''}
        ${b.type === 'miner' ? `<div class="k">矿种</div><div class="v">${b.oreType ? FG.Items.byId(b.oreType).name : '无'}</div>` : ''}
        ${b.type === 'miner' && b.oreType ? `<div class="k">剩余</div><div class="v">${FG.Utils.fmtNum(game.map.amountAt(b.x, b.y))}</div>` : ''}
        ${b.def.recipeBuilding || b.type === 'lab' ? `<div class="k">供料优先级</div><div class="v">${({ high: '高', normal: '中', low: '低' })[b.priority] || '中'}</div>` : ''}
        ${b.def.recipeBuilding ? `<div class="k">产量</div><div class="v">${FG.Utils.fmtNum(b.totalCrafted)}</div>` : ''}
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-top:6px;line-height:1.5">${b.def.desc}</div></div>`;

    // 机械臂：筛选条件 + 下游缺料开关
    if (b.def.inserterTier !== undefined) {
      const solids = FG.Items.list().filter(i => !i.fluid);
      const wanted = FG.game.sim ? FG.game.sim.inserterWanted(b) : null;
      let needTxt = '—';
      if (wanted === null) needTxt = '任意（终端/箱子）';
      else if (!wanted.size) needTxt = '下游暂不缺料';
      else needTxt = Array.from(wanted).slice(0, 5).map(id => FG.Items.byId(id).name).join('、')
        + (wanted.size > 5 ? '…' : '');
      h += `<div class="panel-sec"><h4>取放规则</h4>
        <label class="cfg-row"><input type="checkbox" id="ins-demand" ${b.demandMode ? 'checked' : ''}>
          <span>按需供给：按下游缺口数量与在途预留联动（沿带追踪 ${FG.Config.BELT_TRACE_DEPTH} 格）</span></label>
        <div style="font-size:11px;color:var(--text-dim);margin:4px 0 6px">当前需求：<b style="color:var(--accent2)">${needTxt}</b></div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">筛选物品（点击切换，再点取消）：</div>
        <div class="filter-grid">
          <button class="filter-chip ${b.filter === null ? 'active' : ''}" data-filter="">任意</button>
          ${solids.map(i => `<button class="filter-chip ${b.filter === i.id ? 'active' : ''}" data-filter="${i.id}">${i.name}</button>`).join('')}
        </div></div>`;
    }

    // 生产线供料优先级（消费者：生产建筑 + 实验室）
    if (b.def.recipeBuilding || b.type === 'lab') {
      const cur = b.priority || 'normal';
      const opts = [['high', '高优先', '缺料时优先供料'], ['normal', '普通', '同级轮转公平供料'], ['low', '低优先', '物料紧张时最后供料']];
      h += `<div class="panel-sec"><h4>生产线供料优先级</h4>
        <div class="prio-row">
          ${opts.map(([id, name, tip]) => `<button class="prio-btn prio-${id} ${cur === id ? 'active' : ''}"
            data-prio="${id}" title="${tip}">${name}</button>`).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.5">
          料源紧张时高优先级产线先得料，同优先级轮转均分；在途货物自动预留，在带面上以青色环标记。</div></div>`;
    }

    // 配方选择
    if (b.def.recipeBuilding) {
      const recipes = FG.Recipes.forBuilding(b.type);
      const r = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      if (r) {
        const p = Math.min(1, b.progress / r.time);
        h += `<div class="panel-sec"><h4>生产进度</h4>
          <div class="progress-bar"><div class="fill" style="width:${(p * 100).toFixed(1)}%"></div></div>
          <div style="font-size:11px;color:var(--text-dim)">${r.name} · ${(p * 100).toFixed(0)}%</div></div>`;
      }
      h += `<div class="panel-sec"><h4>配方</h4><div class="recipe-list">`;
      for (const rc of recipes) {
        const unlocked = game.research.isRecipeUnlocked(rc.id);
        const ing = rc.ingredients.map(i => `${FG.Items.byId(i.item).name}×${i.count}`).join(' + ');
        h += `<button class="recipe-btn ${b.recipe === rc.id ? 'selected' : ''} ${unlocked ? '' : 'locked'}"
          data-recipe="${rc.id}"
          title="${unlocked ? '' : '需要研究：' + (FG.Research.byId(rc.unlockedBy) ? FG.Research.byId(rc.unlockedBy).name : rc.unlockedBy)}">
          <span class="rc-name">${rc.name}</span>
          <span class="rc-ing">${ing}</span>
        </button>`;
      }
      h += `</div></div>`;
    }

    // 输入/输出槽
    const hasSlots = Object.keys(b.slots.inputs).length || Object.keys(b.slots.outputs).length;
    if (hasSlots) {
      const recipe = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      const needed = new Set(recipe ? recipe.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
      h += `<div class="panel-sec"><h4>物料</h4>`;
      for (const k of Object.keys(b.slots.inputs)) {
        const s = b.slots.inputs[k];
        const orphan = b.def.recipeBuilding && !needed.has(k);
        h += slotRow((orphan ? '残留 ' : '输入 ') + FG.Items.byId(k).name, s, orphan);
      }
      for (const k of Object.keys(b.slots.outputs)) {
        const s = b.slots.outputs[k];
        h += slotRow('输出 ' + FG.Items.byId(k).name, s);
      }
      h += `</div>`;
    }
    // 流体罐
    if (Object.keys(b.fluidTanks).length) {
      h += `<div class="panel-sec"><h4>流体缓冲</h4>`;
      for (const k of Object.keys(b.fluidTanks)) {
        const cap = FG.Config.FLUID_TANK_CAP;
        h += `<div class="slot-row"><span class="sl-name">${FG.Items.byId(k).name}</span>
          <div class="sl-bar"><div class="fill" style="width:${(b.fluidTanks[k] / cap * 100).toFixed(0)}%"></div></div>
          <span class="sl-count">${FG.Utils.fmtNum(b.fluidTanks[k])}</span></div>`;
      }
      h += `</div>`;
    }
    // 箱子
    if (b.type === 'chest') {
      h += `<div class="panel-sec"><h4>存储</h4>`;
      for (const s of b.chest) {
        h += slotRow(s.type ? FG.Items.byId(s.type).name : '空', s);
      }
      h += `</div>`;
    }

    // 火车站：站名 + 停靠列车货厢
    if (b.def.station) {
      h += `<div class="panel-sec"><h4>火车站</h4>
        <div class="info-grid">
          <div class="k">站点编号</div><div class="v">${b.stationId || '-'}</div>
        </div>
        <label class="cfg-row" style="margin-top:4px">站名
          <input type="text" id="station-name" value="${(b.stationName || '').replace(/"/g, '&quot;')}"
            style="flex:1;margin-left:6px;background:#1a1f2a;border:1px solid #3a4150;color:var(--text);padding:2px 6px;border-radius:3px">
        </label>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.5">
          列车停靠时，格内机械臂可直接向列车货厢<b>装货/卸货</b>（与箱子相同，支持筛选与按需）。</div></div>`;
      const tr = FG.game.railway.dwellingTrainAt(b.x, b.y);
      if (tr) {
        h += `<div class="panel-sec"><h4>停靠列车 ${tr.id}（装卸中）</h4>`;
        for (const s of tr.cargo) {
          h += slotRow(s.type ? FG.Items.byId(s.type).name : '空', s);
        }
        h += `</div>`;
      } else {
        h += `<div class="panel-sec" style="color:var(--text-dim);font-size:11px">当前无列车停靠。</div>`;
      }
    }

    // 铁路信号
    if (b.def.signal) {
      const a = FG.game.railway.signalAhead(b);
      h += `<div class="panel-sec"><h4>铁路信号</h4>
        <div class="info-grid"><div class="k">朝向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>
        <div class="k">灯色</div><div class="v" style="color:${!a.valid ? 'var(--text-dim)' : a.train ? 'var(--red)' : 'var(--green)'}">
          ${!a.valid ? '无效（前方无轨道）' : a.train ? '红灯（前方分区占用）' : '绿灯'}</div></div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.5">
          信号把它正对的轨道边切分为<b>闭塞分区</b>：分区被占用时红灯，列车在信号前等待，避免交叉线路撞车。R 旋转。</div></div>`;
    }

    // 轨道
    if (b.def.rail) {
      const deg = FG.game.map.railDegree(b.x, b.y);
      h += `<div class="panel-sec" style="color:var(--text-dim);font-size:11px;line-height:1.6">
        轨道连接度：<b style="color:var(--text)">${deg}</b>${deg >= 3 ? '（交叉/岔路节点，自动独立闭塞）' : deg === 1 ? '（尽头：列车到此断路）' : ''}<br>
        按住轨道拖拽可连续铺设直线与转弯，十字交叉自动连通。</div>`;
    }

    // 操作按钮
    h += `<div class="action-row">`;
    if (b.def.beltTier !== undefined || b.def.inserterTier !== undefined || b.def.rail || b.def.signal) {
      h += `<button id="btn-rotate">旋转</button>`;
    }
    h += `<button id="btn-demolish" class="danger">${b.def.station ? '拆除车站' : '拆除'}</button>
      <button id="btn-clear">取消选择</button></div>`;

    return h;
  }

  function slotRow(name, s, warn) {
    return `<div class="slot-row${warn ? ' slot-warn' : ''}" title="${warn ? '当前配方不再需要，机械臂会将其运走' : ''}"><span class="sl-name">${name}</span>
      <div class="sl-bar"><div class="fill" style="width:${Math.min(100, s.count / s.cap * 100).toFixed(0)}%"></div></div>
      <span class="sl-count">${FG.Utils.fmtNum(s.count)}/${FG.Utils.fmtNum(s.cap)}</span></div>`;
  }

  // ================= 列车（运输计划） =================
  const TRAIN_STATUS_NAMES = {
    working: '行驶中', blocked: '等待信号/堵站', idle: '无运输计划',
    noPath: '断路停车', dwell: '停站装卸',
  };
  const ACTION_NAMES = { load: '装货', unload: '卸货', none: '仅停靠' };

  function trainInfo(t) {
    const game = FG.game;
    const stations = game.railway.allStations();
    const dest = t.destStationId ? game.railway.stationById(t.destStationId) : null;
    let h = `<div class="panel-sec"><h4>🚃 列车 ${t.id}</h4>
      <div class="info-grid">
        <div class="k">状态</div><div class="v status-${t.status === 'working' ? 'working' : t.status === 'blocked' || t.status === 'noPath' ? 'blocked' : 'idle'}">
          ${t.mode === 'dwell' ? '停站装卸' : (TRAIN_STATUS_NAMES[t.status] || t.status)}</div>
        <div class="k">位置</div><div class="v">(${t.x}, ${t.y})</div>
        <div class="k">目的站</div><div class="v">${dest ? dest.stationName : '—'}</div>
        <div class="k">速度</div><div class="v">${(t.speed * FG.Config.TPS).toFixed(1)} 格/秒</div>
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-top:6px;line-height:1.5">
        列车按下方运输计划循环运行：到站停靠后，格内机械臂自动装卸；
        <b>装货</b>装满或 3 秒无变化发车，<b>卸货</b>卸空或 3 秒无变化发车。</div></div>`;

    // 货厢
    h += `<div class="panel-sec"><h4>货厢（${game.railway.cargoTotal(t)}/${FG.Config.TRAIN_SLOTS * FG.Config.TRAIN_SLOT_CAP}）</h4>`;
    for (const s of t.cargo) h += slotRow(s.type ? FG.Items.byId(s.type).name : '空', s);
    h += `</div>`;

    // 运输计划
    h += `<div class="panel-sec"><h4>运输计划（循环 ${t.schedule.length} 站）</h4>`;
    if (!stations.length) {
      h += `<div style="color:var(--red);font-size:11px">地图上还没有火车站：先在轨道旁放「火车站」建筑。</div>`;
    }
    if (!t.schedule.length) {
      h += `<div style="color:var(--text-dim);font-size:11px;margin-bottom:4px">暂无停靠站，列车静止。用下方选择器添加站点：</div>`;
    }
    t.schedule.forEach((s, i) => {
      const st = game.railway.stationById(s.stationId);
      const isCur = t.mode === 'dwell' ? i === t.schedIndex : -1;
      h += `<div class="bp-plan${isCur >= 0 ? '' : ''}" style="padding:5px 7px;margin-bottom:4px">
        <div class="bp-head">
          <span>${isCur >= 0 ? '🚉 ' : ''}${i + 1}. ${st ? st.stationName : '<span style="color:var(--red)">站点已拆除</span>'}</span>
          <span class="plan-st ${s.action === 'load' ? 'st-active' : s.action === 'unload' ? 'st-waiting' : 'st-paused'}">${ACTION_NAMES[s.action]}</span>
        </div>
        <div class="prio-row plan-prio" style="margin:3px 0">
          ${[['load', '装货'], ['unload', '卸货'], ['none', '停靠']].map(([a, nm]) =>
            `<button class="prio-btn ${s.action === a ? 'active' : ''}" data-sched-act="${i}:${a}"
              style="flex:1;padding:2px 0;font-size:11px">${nm}</button>`).join('')}
        </div>
        <div class="action-row" style="margin-top:2px">
          <button data-sched-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-sched-down="${i}" ${i === t.schedule.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-sched-rm="${i}" class="danger">移除</button>
        </div></div>`;
    });
    // 添加站点
    const avail = stations.filter(st => !t.schedule.some(s => s.stationId === st.stationId));
    if (avail.length) {
      h += `<select id="sched-add-station" style="width:100%;margin-top:2px;background:#1a1f2a;border:1px solid #3a4150;color:var(--text);padding:3px;border-radius:3px">
        <option value="">＋ 添加停靠站…</option>
        ${avail.map(st => `<option value="${st.stationId}">${st.stationName}（${st.stationId}）</option>`).join('')}
      </select>
      <div class="prio-row plan-prio" style="margin:4px 0">
        ${[['load', '装货'], ['unload', '卸货'], ['none', '停靠']].map(([a, nm]) =>
          `<button class="prio-btn ${a === 'load' ? 'active' : ''}" data-sched-add-act="${a}"
            style="flex:1;padding:2px 0;font-size:11px">${nm}</button>`).join('')}
      </div>`;
    }
    h += `</div>`;

    h += `<div class="action-row">
      <button id="btn-train-go">${t.mode === 'dwell' ? '立即发车' : '重新寻路'}</button>
      <button id="btn-demolish" class="danger">拆除列车（货落地）</button>
      <button id="btn-clear">取消选择</button></div>`;
    return h;
  }

  // ================= 统计 =================
  function renderStats() {
    const game = FG.game;
    const stats = game.stats;
    let h = '';

    // 概况
    h += `<div class="panel-sec"><h4>全局状态</h4>
      <div class="info-grid">
        <div class="k">建筑</div><div class="v">${game.totalBuildings()}</div>
        <div class="k">缺料</div><div class="v" style="color:${stats.agg.starveCount ? 'var(--red)' : 'inherit'}">${stats.agg.starveCount}</div>
        <div class="k">堵塞</div><div class="v" style="color:${stats.agg.blockCount ? 'var(--orange)' : 'inherit'}">${stats.agg.blockCount}</div>
      </div></div>`;

    // 瓶颈
    const defs = stats.deficits();
    h += `<div class="panel-sec"><h4>瓶颈分析（近 30s 消耗>产出）</h4>`;
    if (!defs.length && !stats.agg.starveCount && !stats.agg.blockCount) {
      h += `<div style="color:var(--text-dim);font-size:11px">暂无瓶颈，流水线运转良好</div>`;
    } else {
      for (const d of defs.slice(0, 8)) {
        h += `<div class="bottleneck-item warn">
          <span>${FG.Items.byId(d.id).name}</span>
          <span class="gap">缺口 ${FG.Utils.fmtRate(d.gap)}</span>
        </div>`;
      }
      for (const [item, n] of Object.entries(stats.agg.starveByItem)) {
        h += `<div class="bottleneck-item warn"><span>🔴 缺料：${FG.Items.byId(item).name}</span><span class="gap">${n} 座</span></div>`;
      }
      for (const [item, n] of Object.entries(stats.agg.blockByItem)) {
        h += `<div class="bottleneck-item warn"><span>🟠 堵塞：${FG.Items.byId(item).name}</span><span class="gap">${n} 座</span></div>`;
      }
    }
    h += `</div>`;

    // 图表
    h += `<div class="panel-sec"><h4>产量 / 消耗曲线（近 4 分钟）</h4>
      <div class="stats-toolbar" id="chart-items"></div>
      <div class="chart-box"><canvas id="chart-canvas"></canvas></div>
      <div style="font-size:10px;color:var(--text-dim)">
        <span style="color:var(--green)">■ 产出</span> &nbsp; <span style="color:var(--red)">■ 消耗</span>
      </div></div>`;

    // 汇总表
    h += `<div class="panel-sec"><h4>累计产量</h4>`;
    const ids = stats.itemIds().slice(0, 16);
    for (const id of ids) {
      const t = stats.total(id);
      const r = stats.rate(id);
      h += `<div class="rate-row"><span class="rk">${FG.Items.byId(id).name}</span>
        <span class="rv">${FG.Utils.fmtNum(t.p)} 累计 · ${FG.Utils.fmtRate(r.p)} 产出 · ${FG.Utils.fmtRate(r.c)} 消耗</span></div>`;
    }
    if (!ids.length) h += `<div style="color:var(--text-dim);font-size:11px">尚无生产记录</div>`;
    h += `</div>`;

    bodyEl().innerHTML = h;

    // 图表物品选择
    const chipWrap = document.getElementById('chart-items');
    if (chipWrap) {
      if (!chartItems.length) chartItems = ids.slice(0, 4);
      for (const id of ids) {
        const chip = document.createElement('span');
        chip.className = 'chip-item' + (chartItems.includes(id) ? ' active' : '');
        chip.textContent = FG.Items.byId(id).name;
        chip.onclick = () => {
          if (chartItems.includes(id)) chartItems = chartItems.filter(i => i !== id);
          else { if (chartItems.length < 5) chartItems.push(id); }
          renderStats();
        };
        chipWrap.appendChild(chip);
      }
      drawChart();
    }
  }

  function drawChart() {
    const cv = document.getElementById('chart-canvas');
    if (!cv) return;
    const stats = FG.game.stats;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = cv.clientWidth, H = cv.clientHeight;
    ctx.fillStyle = '#12151d';
    ctx.fillRect(0, 0, W, H);
    if (!chartItems.length) return;

    // 计算 Y 范围
    let maxV = 1;
    const hist = stats.history;
    for (const id of chartItems) {
      for (const bk of hist) {
        maxV = Math.max(maxV, bk.p[id] || 0, bk.c[id] || 0);
      }
    }
    const pad = 4;
    const step = hist.length > 1 ? (W - pad * 2) / (hist.length - 1) : W;

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (H - pad * 2) * (i / 4);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    }

    for (const id of chartItems) {
      const color = FG.Items.byId(id).color;
      for (const [kind, key, kcol] of [['p', 'p', color], ['c', 'c', 'rgba(224,92,92,0.9)']]) {
        ctx.strokeStyle = kind === 'p' ? color : 'rgba(224,92,92,0.85)';
        ctx.lineWidth = kind === 'p' ? 2 : 1.5;
        ctx.beginPath();
        hist.forEach((bk, i) => {
          const v = bk[key][id] || 0;
          const x = pad + i * step;
          const y = H - pad - (v / maxV) * (H - pad * 2);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
    // 图例当前值
    ctx.fillStyle = '#8b93a8';
    ctx.font = '10px Consolas';
    chartItems.forEach((id, i) => {
      const r = stats.rate(id);
      ctx.fillText(`${FG.Items.byId(id).name} 产出${FG.Utils.fmtRate(r.p)}`, pad + 4, 14 + i * 12);
    });
  }

  // ================= 施工（蓝图） =================
  function renderBuild() {
    const game = FG.game;
    const cons = game.construction;
    let h = '';

    // 当前蓝图（剪贴板）
    h += `<div class="panel-sec"><h4>蓝图</h4>`;
    h += `<div class="action-row" style="margin-bottom:6px">
      <button id="build-open-pipeline">⚡ 一键流水线 (P)</button>
    </div>`;
    if (game.blueprint) {
      const bp = game.blueprint;
      const cost = FG.Blueprint.costOf(bp);
      const costTxt = Object.keys(cost).map(k => FG.Items.byId(k).name + '×' + cost[k]).join('　');
      const preset = bp.fromPreset ? FG.Pipelines.byId(bp.fromPreset) : null;
      h += `<div class="info-grid">
        <div class="k">来源</div><div class="v">${preset ? '⚡ ' + preset.name : '框选蓝图'}</div>
        <div class="k">规模</div><div class="v">${bp.entries.length} 栋 · ${bp.w}×${bp.h}</div>
        <div class="k">建材</div><div class="v" style="font-family:inherit">${costTxt || '无'}</div>
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-top:6px;line-height:1.6">
        ${preset ? '左键提交整套施工 · <b>R</b> 旋转 · <b>F</b> 重新智能选位 · 可连续盖章。'
          : '按 <b>B</b> 放置预览：移动选位、<b>R</b> 旋转、左键提交施工计划；再按 <b>B</b> 重新框选。'}
      </div>`;
    } else {
      h += `<div style="color:var(--text-dim);font-size:11px;line-height:1.7">
        按 <b>P</b> 选择<b style="color:var(--accent2)">预设流水线</b>一键铺设，或按 <b>B</b> 框选已有产线生成蓝图。<br>
        施工计划自动从<b>箱子 / 地面物料堆</b>预留建材；缺料时等待，取消时返还。
      </div>`;
    }
    h += `</div>`;

    // 施工计划列表（高优先级排前，同级按提交顺序）
    const order = { high: 0, normal: 1, low: 2 };
    const sorted = cons.plans.slice().sort((a, b) => (order[a.priority] - order[b.priority]));
    h += `<div class="panel-sec"><h4>施工计划（${cons.plans.length}）</h4>`;
    if (!cons.plans.length) {
      h += `<div style="color:var(--text-dim);font-size:11px">暂无进行中的施工计划</div>`;
    }
    for (const p of sorted) {
      const total = p.entries.length;
      const done = p.entries.filter(e => e.state === 'done').length;
      const skipped = p.entries.filter(e => e.state === 'skip').length;
      let head = null;
      for (let i = p.cursor; i < total; i++) {
        if (p.entries[i].state === 'wait') { head = p.entries[i]; break; }
      }
      if (!head) head = p.entries.find(e => e.state === 'wait') || null;
      const st = planStatus(p);
      h += `<div class="bp-plan${p.paused ? ' is-paused' : ''}">
        <div class="bp-head"><span title="${p.id}">${p.name}</span><span class="plan-st ${st.cls}">${st.txt}</span></div>
        <div class="progress-bar"><div class="fill" style="width:${(done / total * 100).toFixed(1)}%"></div></div>
        <div style="font-size:11px;color:var(--text-dim)">进度 ${done}/${total} 栋${skipped ? ' · 跳过 ' + skipped : ''}</div>`;

      // 计划优先级：高/中/低 —— 统一建材池分层拨付，高层未取料前低层等待
      h += `<div class="prio-row plan-prio">
        ${[['high', '高'], ['normal', '中'], ['low', '低']].map(([id, nm]) =>
          `<button class="prio-btn prio-${id} ${p.priority === id ? 'active' : ''}" data-plan-prio="${p.id}:${id}">${nm}</button>`).join('')}
      </div>`;

      // 前置依赖
      const depChips = p.deps.map(id => {
        const d = cons.byId(id);
        return d
          ? `<span class="dep-chip">⛓ ${d.name} <b data-plan-dep-rm="${p.id}:${id}" title="移除前置">×</b></span>`
          : '';
      }).join('');
      const canDeps = cons.plans.filter(q => q.id !== p.id && !p.deps.includes(q.id) && !dependsOn(q, p.id));
      h += `<div class="dep-row">${depChips}`;
      if (canDeps.length) {
        h += `<select class="dep-select" data-plan-dep-add="${p.id}">
          <option value="">＋ 设前置…</option>
          ${canDeps.map(q => `<option value="${q.id}">${q.name}</option>`).join('')}
        </select>`;
      }
      h += `</div>`;

      // 当前待建条目与条目级预留
      if (head && head.state === 'wait') {
        const def = FG.Buildings.byId(head.type);
        const cost = FG.Buildings.costOf(head.type);
        const parts = Object.keys(cost).map(k =>
          `${FG.Items.byId(k).name} ${Math.min(head.stock[k] || 0, cost[k])}/${cost[k]}`);
        h += `<div style="font-size:11px;color:var(--text-dim);margin-top:3px">待建：${def.name}（${head.x},${head.y}）${parts.length ? ' · ' + parts.join(' · ') : ''}</div>`;
        if (!p.paused && !p.blocked && p.waiting) {
          h += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">前沿缺料：后续能凑齐建材的建筑会先行建成</div>`;
        }
        if (p.blocked) {
          const names = p.deps.map(id => cons.byId(id) ? cons.byId(id).name : null).filter(Boolean).join('、');
          h += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">等待前置计划完工：${names}</div>`;
        }
      }
      h += `<div class="action-row">
        <button data-plan-pause="${p.id}">${p.paused ? '▶ 继续' : '⏸ 暂停'}</button>
        <button data-cancel-plan="${p.id}" class="danger">取消并返还建材</button>
      </div></div>`;
    }
    h += `</div>`;
    bodyEl().innerHTML = h;
    const btnPipeline = bodyEl().querySelector('#build-open-pipeline');
    if (btnPipeline) btnPipeline.onclick = () => FG.Modals.pipelines();
    for (const el of bodyEl().querySelectorAll('[data-cancel-plan]')) {
      el.onclick = () => { FG.game.cancelConstruction(el.dataset.cancelPlan); };
    }
    for (const el of bodyEl().querySelectorAll('[data-plan-prio]')) {
      el.onclick = () => {
        const [id, pri] = el.dataset.planPrio.split(':');
        FG.game.setPlanPriority(id, pri);
      };
    }
    for (const el of bodyEl().querySelectorAll('[data-plan-pause]')) {
      el.onclick = () => { FG.game.togglePlanPaused(el.dataset.planPause); };
    }
    for (const el of bodyEl().querySelectorAll('[data-plan-dep-rm]')) {
      el.onclick = () => {
        const [id, dep] = el.dataset.planDepRm.split(':');
        FG.game.removePlanDep(id, dep);
      };
    }
    for (const sel of bodyEl().querySelectorAll('[data-plan-dep-add]')) {
      sel.onchange = () => {
        if (sel.value) FG.game.addPlanDep(sel.dataset.planDepAdd, sel.value);
      };
    }
  }

  /** 计划状态徽章 */
  function planStatus(p) {
    if (p.paused) return { txt: '已暂停', cls: 'st-paused' };
    if (p.blocked) return { txt: '等待前置', cls: 'st-blocked' };
    if (p.waiting) return { txt: '缺料等待', cls: 'st-waiting' };
    return { txt: '施工中', cls: 'st-active' };
  }

  /** q 是否（经依赖链传递）依赖 planId —— 用于过滤会成环的前置选项 */
  function dependsOn(q, planId) {
    const cons = FG.game.construction;
    const stack = q.deps.slice();
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === planId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const d = cons.byId(id);
      if (d) stack.push(...d.deps);
    }
    return false;
  }

  // ================= 日志 =================
  function renderLog() {
    const game = FG.game;
    let h = `<div class="panel-sec"><h4>事件日志</h4><div class="log-list">`;
    for (const l of game.log) {
      const t = new Date(l.t);
      h += `<div class="log-line msg-${l.cls}"><span class="log-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span>${l.text}</div>`;
    }
    h += `</div></div>`;
    bodyEl().innerHTML = h;
    bodyEl().scrollTop = bodyEl().scrollHeight;
  }

  function bindTrainActions(t) {
    const game = FG.game;
    const refresh = () => render();
    for (const el of document.querySelectorAll('[data-sched-act]')) {
      el.onclick = () => {
        const [i, a] = el.dataset.schedAct.split(':');
        const s = t.schedule[+i];
        if (s && ['load', 'unload', 'none'].includes(a)) { s.action = a; FG.Events.emit('railway:change'); refresh(); }
      };
    }
    for (const el of document.querySelectorAll('[data-sched-rm]')) {
      el.onclick = () => {
        const i = +el.dataset.schedRm;
        t.schedule.splice(i, 1);
        if (t.schedIndex >= t.schedule.length) t.schedIndex = 0;
        t.repathCd = 0;
        FG.Events.emit('railway:change'); refresh();
      };
    }
    for (const el of document.querySelectorAll('[data-sched-up]')) {
      el.onclick = () => {
        const i = +el.dataset.schedUp;
        if (i > 0) { [t.schedule[i - 1], t.schedule[i]] = [t.schedule[i], t.schedule[i - 1]]; FG.Events.emit('railway:change'); refresh(); }
      };
    }
    for (const el of document.querySelectorAll('[data-sched-down]')) {
      el.onclick = () => {
        const i = +el.dataset.schedDown;
        if (i < t.schedule.length - 1) { [t.schedule[i + 1], t.schedule[i]] = [t.schedule[i], t.schedule[i + 1]]; FG.Events.emit('railway:change'); refresh(); }
      };
    }
    const addSel = document.getElementById('sched-add-station');
    if (addSel) {
      addSel.onchange = () => {
        const sid = addSel.value;
        if (!sid) return;
        const actBtn = document.querySelector('[data-sched-add-act].active');
        const action = actBtn ? actBtn.dataset.schedAddAct : 'load';
        t.schedule.push({ stationId: sid, action });
        if (t.mode === 'idle') { t.schedIndex = t.schedule.length - 1; t.repathCd = 0; }
        FG.Events.emit('railway:change'); refresh();
      };
    }
    for (const el of document.querySelectorAll('[data-sched-add-act]')) {
      el.onclick = () => {
        for (const x of document.querySelectorAll('[data-sched-add-act]')) x.classList.toggle('active', x === el);
      };
    }
    const go = document.getElementById('btn-train-go');
    if (go) go.onclick = () => {
      if (t.mode === 'dwell') game.railway.forceDepart(t);
      else { t.repathCd = 0; game.logMsg('列车 ' + t.id + '：已请求重新寻路', 'info'); }
    };
  }

  function bindActions() {
    const game = FG.game;
    const sel = game.selection;
    // 火车站改名
    const nameInput = document.getElementById('station-name');
    if (nameInput && sel && sel.def && sel.def.station) {
      nameInput.onchange = () => { game.railway.renameStation(sel.stationId, nameInput.value.trim() || sel.stationName); };
    }
    // 列车运输计划
    if (sel && sel.type === 'train') bindTrainActions(sel);
    const btn = document.getElementById('btn-demolish');
    if (btn) btn.onclick = () => { if (FG.game.selection) FG.game.removeBuilding(FG.game.selection); };
    const rot = document.getElementById('btn-rotate');
    if (rot) rot.onclick = () => {
      const b = FG.game.selection;
      if (b) { b.dir = (b.dir + 1) % 4; render(); }
    };
    const clr = document.getElementById('btn-clear');
    if (clr) clr.onclick = () => { FG.game.selection = null; FG.Events.emit('selection:change'); };
    for (const el of document.querySelectorAll('.recipe-btn')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        const rid = el.dataset.recipe;
        if (!FG.game.research.isRecipeUnlocked(rid)) return;
        FG.game.setRecipe(b, rid);
      };
    }
    const dm = document.getElementById('ins-demand');
    if (dm) dm.onchange = () => {
      const b = FG.game.selection;
      if (b) { b.demandMode = dm.checked; render(); }
    };
    for (const el of document.querySelectorAll('.filter-chip')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        b.filter = el.dataset.filter || null;
        render();
      };
    }
    for (const el of document.querySelectorAll('.prio-btn')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        b.priority = el.dataset.prio;
        render();
      };
    }
  }

  return { init, render, bindActions };
})();
