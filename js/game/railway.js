/**
 * FG.Railway —— 铁路货运系统
 *
 * 组成：
 *  - 轨道节点（rail / trainStop 建筑）：4 邻接无向图，十字交叉天然支持多邻接（岔路）；
 *  - 闭塞分区（block）：由拓扑自动切分 —— 火车站、岔路口（邻接≥3）各自独立成区，
 *    铁路信号所在格朝向的轨道边成为分区边界；同一分区同一时刻只允许一列车占用，
 *    列车在进入分区前看信号/占用情况，红灯则在边界前等待（交叉线路争用）；
 *  - 列车：沿 BFS 最短路逐格行驶，自带 3 货厢槽；到站停靠（dwell）期间机械臂可直接
 *    从列车上装/卸货物（与箱子同为物流终端），按运输计划执行 load/unload/none；
 *  - 堵站：目的站分区被别的列车占用时，后车在站外分区边界停车等待；
 *  - 断路：轨道拆除导致无路可走时列车 noPath 停车，路网修复/定时自动重新寻路；
 *  - 存档：列车货厢、行驶位置/速度、运输计划、停站调度计数全部序列化（路径不存档，
 *    读档后按当前路网重新寻路）。
 */
FG.Railway = class Railway {
  constructor(game) {
    this.game = game;
    this.trains = [];
    this.seq = 1;
    this.stationSeq = 1;
    // 闭塞
    this.blockOf = new Map();   // tile key -> blockId
    this.cutEdges = new Set();  // 'x,y-x,y' 被信号切断的轨道边
    this.occupant = new Map();  // blockId -> trainId
    this.dirty = true;
    this._phys = new Map();     // 本 tick 列车物理占格 key -> train
  }

  reset() {
    this.trains = [];
    this.seq = 1;
    this.stationSeq = 1;
    this.blockOf.clear();
    this.cutEdges.clear();
    this.occupant.clear();
    this.dirty = true;
  }

  // ================= 车站 =================
  allStations() {
    const out = [];
    if (!this.game.map) return out;
    for (const b of this.game.map.buildings.values()) if (b.def.station) out.push(b);
    return out;
  }

  stationById(id) {
    if (!id) return null;
    for (const b of this.game.map.buildings.values()) {
      if (b.def.station && b.stationId === id) return b;
    }
    return null;
  }

  /** 给新落成的火车站分配唯一 id/名称（蓝图复制的车站也会得到新 id） */
  registerStation(b) {
    if (!b.def.station) return;
    if (!b.stationId || this.stationById(b.stationId)) {
      b.stationId = 'S' + (this.stationSeq++);
    }
    if (!b.stationName) b.stationName = '装料站 ' + b.stationId.slice(1);
    this.markDirty();
  }

  renameStation(id, name) {
    const b = this.stationById(id);
    if (b && name) { b.stationName = name; FG.Events.emit('railway:change'); }
  }

  // ================= 列车 =================
  createTrain(x, y) {
    const def = FG.Buildings.byId('train');
    const cap = FG.Config.TRAIN_SLOT_CAP;
    const t = {
      def, type: 'train',
      id: 'T' + (this.seq++),
      x, y, progress: 0,
      px: x, py: y,
      heading: 1,
      speed: 0,
      mode: 'idle',           // idle | path | dwell | noPath
      status: 'idle',         // 复用建筑状态词：working/blocked/idle + noPath
      schedule: [],           // [{stationId, action: 'load'|'unload'|'none'}]
      schedIndex: 0,
      path: null,             // [{x,y}...]，含当前格，pi 指向当前格下标
      pi: 0,
      destStationId: null,
      cargo: [],
      dwellTicks: 0,
      idleTicks: 0,
      lastCargo: 0,
      repathCd: 0,
    };
    for (let i = 0; i < FG.Config.TRAIN_SLOTS; i++) t.cargo.push({ type: null, count: 0, cap });
    return t;
  }

  addTrain(x, y) {
    if (!this.game.map.isRailNodeAt(x, y)) return null;
    if (this.trainAtTile(x, y)) return null;
    const t = this.createTrain(x, y);
    this.trains.push(t);
    FG.Events.emit('railway:change');
    return t;
  }

  removeTrain(t) {
    const i = this.trains.indexOf(t);
    if (i < 0) return;
    // 货厢物料不丢失：落到车站/轨道格地面堆
    for (const s of t.cargo) if (s.count > 0) this.game.map.pileAdd(t.x, t.y, s.type, s.count);
    this.trains.splice(i, 1);
    if (this.game.selection === t) {
      this.game.selection = null;
      FG.Events.emit('selection:change');
    }
    FG.Events.emit('railway:change');
  }

  byId(id) { return this.trains.find(t => t.id === id) || null; }

  /** 指定格上的列车（整数格；跨边行驶时前后两格都算占用） */
  trainAtTile(x, y) {
    const k = FG.Utils.key(x, y);
    return this._phys.get(k) || null;
  }

  /** 停站装卸中的列车（机械臂可访问），其它状态下列车货厢不开放 */
  dwellingTrainAt(x, y) {
    const t = this.trainAtTile(x, y);
    return t && t.mode === 'dwell' ? t : null;
  }

  markDirty() { this.dirty = true; }

  // ================= 货厢（机械臂接口，语义同箱子） =================
  cargoCanAdd(t, type) {
    for (const s of t.cargo) if (s.type === type && s.count < s.cap) return true;
    return t.cargo.some(s => s.count === 0);
  }

  cargoAdd(t, type, n) {
    for (const s of t.cargo) {
      if (s.type === type && s.count < s.cap) {
        const put = Math.min(n, s.cap - s.count);
        s.count += put; n -= put;
      }
    }
    for (const s of t.cargo) {
      if (n <= 0) break;
      if (s.count === 0) {
        const put = Math.min(n, s.cap);
        s.type = type; s.count = put; n -= put;
      }
    }
    return n;
  }

  cargoTakeOne(t, wanted) {
    const i = wanted ? t.cargo.findIndex(s => s.type === wanted && s.count > 0)
                     : t.cargo.findIndex(s => s.count > 0);
    if (i < 0) return null;
    const type = t.cargo[i].type;
    t.cargo[i].count--;
    if (t.cargo[i].count <= 0) t.cargo[i].type = null;
    return type;
  }

  cargoTotal(t) { return t.cargo.reduce((n, s) => n + s.count, 0); }

  // ================= 闭塞分区构建 =================
  /**
   * 自动闭塞规则：
   *  - 火车站、岔路口（轨道邻接度 ≥3）：与所有邻接轨道之间的边切断，自身单独成区；
   *  - 铁路信号：信号在 (x,y) 朝向 d，前方轨道格 A=(x,y)+v，再前一格 B=A+v，
   *    切断 A-B 边（双向）；列车进入 B 所在分区前须该区空闲。
   */
  rebuildBlocks() {
    this.dirty = false;
    this.blockOf.clear();
    this.cutEdges.clear();
    const m = this.game.map;

    for (const b of m.buildings.values()) {
      if (b.def.signal) {
        const v = FG.Utils.dirVec(b.dir);
        const a = m.railBuildingAt(b.x + v.x, b.y + v.y);
        // 信号立在轨道旁的地面格：正前方轨道格 A 被标记为「信号防护格」，
        // 与所有邻接轨道之间的边切断（A 成为单格分区）。列车进入 A 前看灯：
        // A 被占用即红灯，在 A 的前一格停车 —— 与岔路方向无关，交叉处同样无歧义。
        if (a) this.signalCells.add(FG.Utils.key(a.x, a.y));
      }
    }

    let bid = 0;
    const flood = (sx, sy) => {
      const id = ++bid;
      const q = [[sx, sy]];
      this.blockOf.set(FG.Utils.key(sx, sy), id);
      while (q.length) {
        const [x, y] = q.shift();
        const cur = m.railBuildingAt(x, y);
        const junction = cur && (cur.def.station || m.railDegree(x, y) >= 3
          || this.signalCells.has(FG.Utils.key(x, y)));
        if (junction) continue; // 站/岔路口/信号防护格不向邻接扩展（独立单格分区）
        for (const d of m.railNeighborDirs(x, y)) {
          const v = FG.Utils.dirVec(d);
          const nx = x + v.x, ny = y + v.y;
          const nb = m.railBuildingAt(nx, ny);
          if (!nb || this.blockOf.has(FG.Utils.key(nx, ny))) continue;
          if (nb.def.station || m.railDegree(nx, ny) >= 3
              || this.signalCells.has(FG.Utils.key(nx, ny))) continue;
          this.blockOf.set(FG.Utils.key(nx, ny), id);
          q.push([nx, ny]);
        }
      }
    };

    for (const b of m.buildings.values()) {
      if ((b.def.rail || b.def.station) && !this.blockOf.has(FG.Utils.key(b.x, b.y))) {
        flood(b.x, b.y);
      }
    }
    // 重新登记占用
    this.occupant.clear();
    for (const t of this.trains) {
      const bk = this.blockOf.get(FG.Utils.key(t.x, t.y));
      if (bk) this.occupant.set(bk, t.id);
    }
  }

  blockAt(x, y) { return this.blockOf.get(FG.Utils.key(x, y)) || null; }

  /** 信号防护的前方分区（valid=false=朝向无效；train=null=空闲可通行，否则为占用列车） */
  signalAhead(sig) {
    const m = this.game.map;
    const v = FG.Utils.dirVec(sig.dir);
    const self = m.railBuildingAt(sig.x, sig.y);
    // 防护目标格：信号在地面时为再前一格 B；在轨道格上时为正前一格 A
    const tx = self ? sig.x + v.x : sig.x + v.x * 2;
    const ty = self ? sig.y + v.y : sig.y + v.y * 2;
    const target = m.railBuildingAt(tx, ty);
    if (!target) return { valid: false, train: null };
    const bk = this.blockOf.get(FG.Utils.key(target.x, target.y));
    const tid = bk ? this.occupant.get(bk) : null;
    return { valid: true, train: tid ? this.byId(tid) : null };
  }

  // ================= 寻路（BFS 最短路，忽略占用；争用由闭塞停车处理） =================
  findPath(sx, sy, tx, ty) {
    const m = this.game.map;
    if (!m.isRailNodeAt(sx, sy) || !m.isRailNodeAt(tx, ty)) return null;
    if (sx === tx && sy === ty) return [{ x: sx, y: sy }];
    const prev = new Map();
    const startK = FG.Utils.key(sx, sy);
    prev.set(startK, null);
    const q = [[sx, sy]];
    let found = false;
    while (q.length && prev.size <= FG.Config.TRAIN_PATH_NODES) {
      const [x, y] = q.shift();
      if (x === tx && y === ty) { found = true; break; }
      for (let d = 0; d < 4; d++) {
        const v = FG.Utils.dirVec(d);
        const nx = x + v.x, ny = y + v.y;
        if (!m.isRailNodeAt(nx, ny)) continue;
        const k = FG.Utils.key(nx, ny);
        if (prev.has(k)) continue;
        prev.set(k, FG.Utils.key(x, y));
        q.push([nx, ny]);
      }
    }
    if (!found) return null;
    const path = [];
    let k = FG.Utils.key(tx, ty);
    while (k) {
      const [x, y] = k.split(',').map(Number);
      path.push({ x, y });
      k = prev.get(k);
    }
    path.reverse();
    return path;
  }

  // ================= 运输计划 =================
  /** 计划中从 fromIndex 起第一个仍存在的站点（已拆除的站自动跳过） */
  nextValidStop(t, fromIndex) {
    const n = t.schedule.length;
    for (let i = 0; i < n; i++) {
      const idx = (fromIndex + i) % n;
      const e = t.schedule[idx];
      if (e && this.stationById(e.stationId)) return { entry: e, index: idx };
    }
    return null;
  }

  /** 让列车开往下一计划站（当前无可用站 → idle/noPath） */
  dispatchNext(t) {
    const stop = this.nextValidStop(t, t.schedIndex);
    if (!stop) {
      t.mode = this.game.map.isRailNodeAt(t.x, t.y) ? 'idle' : 'noPath';
      t.path = null; t.destStationId = null; t.speed = 0;
      return;
    }
    t.schedIndex = stop.index;
    t.destStationId = stop.entry.stationId;
    const st = this.stationById(stop.entry.stationId);
    const path = this.findPath(t.x, t.y, st.x, st.y);
    if (path && path.length > 1) {
      t.path = path; t.pi = 0; t.mode = 'path'; t.repathCd = 30;
    } else if (path && path.length === 1) {
      // 已在站上：直接入站停靠
      t.path = path; t.pi = 0; t.status = 'working';
      this.arrive(t);
    } else {
      t.mode = 'noPath'; t.path = null; t.status = 'noPath'; t.repathCd = 60;
      this.logThrottled(t, '⚠ 列车 ' + t.id + ' 无法到达「' + st.stationName + '」：轨道断路，等待路网恢复');
    }
  }

  logThrottled(t, msg) {
    const now = this.game.tickCount;
    if (now - (t._lastLog || 0) > 200) { t._lastLog = now; this.game.logMsg(msg, 'error'); }
  }

  /** 立即发车（面板按钮，忽略装卸等待条件） */
  forceDepart(t) { if (t.mode === 'dwell') this.endDwell(t); }

  endDwell(t) {
    t.mode = 'path';
    t.schedIndex = (t.schedIndex + 1) % Math.max(1, t.schedule.length);
    this.dispatchNext(t);
    FG.Events.emit('railway:change');
  }

  // ================= 仿真主循环 =================
  tick() {
    if (this.dirty) this.rebuildBlocks();
    // 物理占格快照：跨边（progress≥0.5）时前后两格都占用
    this._phys.clear();
    for (const t of this.trains) {
      this._phys.set(FG.Utils.key(t.x, t.y), t);
      if (t.path && t.progress >= 0.5 && t.path[t.pi + 1]) {
        const n = t.path[t.pi + 1];
        if (!this._phys.has(FG.Utils.key(n.x, n.y))) this._phys.set(FG.Utils.key(n.x, n.y), t);
      }
    }
    for (const t of this.trains) this.updateTrain(t);
  }

  updateTrain(t) {
    if (t.mode === 'dwell') { this.updateDwell(t); return; }
    if (!t.schedule.length) { t.mode = 'idle'; t.status = 'idle'; t.speed = 0; return; }
    if (t.mode === 'idle') this.dispatchNext(t);

    // 定时重新寻路（堵站等待 / 断路修复后自动恢复）
    if (--t.repathCd <= 0) {
      t.repathCd = t.mode === 'noPath' ? 60 : 120;
      const st = this.stationById(t.destStationId);
      if (st) {
        const path = this.findPath(t.x, t.y, st.x, st.y);
        if (path) {
          if (path.length === 1) { this.arrive(t); return; }
          t.path = path; t.pi = 0; t.mode = 'path'; t.status = 'working';
        } else if (t.mode !== 'noPath') {
          t.mode = 'noPath'; t.status = 'noPath';
          this.logThrottled(t, '⚠ 列车 ' + t.id + ' 前方断路，停车等待');
        }
      } else {
        this.dispatchNext(t);
      }
    }
    if (t.mode === 'noPath' || !t.path) { t.status = 'noPath'; return; }

    // 路径失效（轨道被拆）
    if (t.pi >= t.path.length - 1 || !this.game.map.isRailNodeAt(t.x, t.y)) {
      this.dispatchNext(t);
      return;
    }

    this.drive(t);
  }

  /** 沿路径行驶：以制动距离计算最近停车点（闭塞边界/红灯/前车/目的站） */
  drive(t) {
    const C = FG.Config;
    const m = this.game.map;
    const next = t.path[t.pi + 1];
    if (!m.isRailNodeAt(next.x, next.y)) { this.dispatchNext(t); return; }
    t.heading = dirFromTo(t.x, t.y, next.x, next.y);

    // ---- 沿路径前行方向搜索最近停车点距离 D（自列车前端当前位置起，单位：格） ----
    let D = Infinity;
    let stopKind = null;
    const consider = (dist, kind) => { if (dist < D) { D = dist; stopKind = kind; } };
    const target = this.stationById(t.destStationId);

    let cx = t.x, cy = t.y;
    let distBase = 1 - t.progress; // 到 next 格中心的距离
    for (let i = t.pi + 1; i < t.path.length; i++) {
      const node = t.path[i];
      const dCenter = distBase + (i - t.pi - 1);
      const prevNode = i === t.pi + 1 ? { x: t.x, y: t.y } : t.path[i - 1];

      // 物理障碍：别的列车占格 → 停在前一格中心（堵站时后车停在站外）
      const occ = this._phys.get(FG.Utils.key(node.x, node.y));
      if (occ && occ !== t) { consider(dCenter - 1, 'train'); break; }
      // 闭塞边界：进入新区分前，分区被别的列车占用 → 停在边界（dCenter-0.5，红灯）
      const bkNew = this.blockOf.get(FG.Utils.key(node.x, node.y));
      const bkOld = this.blockOf.get(FG.Utils.key(prevNode.x, prevNode.y));
      if (bkNew && bkNew !== bkOld) {
        const holder = this.occupant.get(bkNew);
        if (holder && holder !== t.id) { consider(dCenter - 0.5, 'block'); break; }
      }
      // 目的站：分区空闲时精确停在站格中心
      if (target && node.x === target.x && node.y === target.y) {
        consider(dCenter, 'station');
        break; // 站后路径不再延伸
      }
    }
    if (D === Infinity) D = 999;

    // ---- 速度规划：制动曲线限速 v ≤ √(2bD)，否则按巡航加速 ----
    const limit = Math.sqrt(2 * C.TRAIN_BRAKE * Math.max(0, D));
    if (t.speed > limit + 0.0001) t.speed = Math.max(limit, t.speed - C.TRAIN_EMERGENCY_BRAKE);
    else t.speed = Math.min(C.TRAIN_SPEED, t.speed + C.TRAIN_ACCEL);
    if (D <= 0.001) t.speed = 0;

    // ---- 位移 ----
    t.progress += t.speed;
    if (t.progress >= 1) {
      // 跨入下一格：最终物理占用校验（双保险，正常由制动距离保证不越界）
      const other = this._phys.get(FG.Utils.key(next.x, next.y));
      if (other && other !== t) { t.progress = 0.99; t.speed = 0; }
      else {
        const oldBk = this.blockOf.get(FG.Utils.key(t.x, t.y));
        t.x = next.x; t.y = next.y; t.progress = 0; t.pi++;
        const newBk = this.blockOf.get(FG.Utils.key(t.x, t.y));
        if (oldBk !== newBk) {
          if (oldBk && this.occupant.get(oldBk) === t.id) this.occupant.delete(oldBk);
          if (newBk) this.occupant.set(newBk, t.id);
        }
        this._phys.set(FG.Utils.key(t.x, t.y), t);
        // 到站
        if (target && t.x === target.x && t.y === target.y) { this.arrive(t); return; }
        if (t.pi >= t.path.length - 1) { this.dispatchNext(t); return; }
      }
    }

    // 状态：贴住停车点停车 → blocked（红灯/堵站/前车）；行驶中 → working
    if (t.speed <= 0.001 && D <= 0.55) { t.status = 'blocked'; t.mode = 'path'; }
    else { t.status = 'working'; }
    const v = FG.Utils.dirVec(t.heading);
    t.px = t.x + v.x * t.progress;
    t.py = t.y + v.y * t.progress;
  }

  arrive(t) {
    t.speed = 0; t.progress = 0;
    t.px = t.x; t.py = t.y;
    t.mode = 'dwell';
    t.status = 'working';
    t.dwellTicks = 0; t.idleTicks = 0;
    t.lastCargo = this.cargoTotal(t);
    const bk = this.blockOf.get(FG.Utils.key(t.x, t.y));
    if (bk) this.occupant.set(bk, t.id);
    FG.Events.emit('railway:change');
  }

  /** 停站装卸：机械臂在这期间可访问货厢；满足发车条件后进入下一计划站 */
  updateDwell(t) {
    const C = FG.Config;
    t.dwellTicks++;
    // 站被拆除：立即离开
    const st = this.stationById(t.destStationId);
    if (!st || (st.x !== t.x || st.y !== t.y)) { this.endDwell(t); return; }

    const total = this.cargoTotal(t);
    if (total === t.lastCargo) t.idleTicks++;
    else { t.idleTicks = 0; t.lastCargo = total; }

    const entry = t.schedule[t.schedIndex] || { action: 'none' };
    const full = total >= C.TRAIN_SLOTS * C.TRAIN_SLOT_CAP;
    let go = false;
    if (entry.action === 'load') {
      if (full) go = true;
      else if (t.dwellTicks >= C.TRAIN_DWELL_MIN && t.idleTicks >= C.TRAIN_INACT_TICKS) go = true;
    } else if (entry.action === 'unload') {
      if (total === 0) go = true;
      else if (t.dwellTicks >= C.TRAIN_DWELL_MIN && t.idleTicks >= C.TRAIN_INACT_TICKS) go = true;
    } else if (t.dwellTicks >= C.TRAIN_WAIT_TICKS) {
      go = true;
    }
    if (go) this.endDwell(t);
  }

  // ================= 存档 =================
  serialize() {
    return {
      seq: this.seq, stationSeq: this.stationSeq,
      trains: this.trains.map(t => ({
        id: t.id, x: t.x, y: t.y, progress: t.progress, heading: t.heading,
        speed: t.speed, mode: t.mode, status: t.status,
        schedule: t.schedule.map(s => ({ stationId: s.stationId, action: s.action })),
        schedIndex: t.schedIndex, destStationId: t.destStationId,
        cargo: t.cargo.map(s => ({ type: s.type, count: s.count, cap: s.cap })),
        dwellTicks: t.dwellTicks, idleTicks: t.idleTicks, lastCargo: t.lastCargo,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) { this.markDirty(); return; }
    this.seq = data.seq || 1;
    this.stationSeq = data.stationSeq || 1;
    for (const st0 of (data.trains || [])) {
      const t = this.createTrain(st0.x, st0.y);
      t.id = st0.id || t.id;
      t.progress = st0.progress || 0;
      t.heading = st0.heading || 1;
      t.speed = st0.speed || 0;
      t.mode = 'idle';            // 路径不存档：读档后按当前路网重新寻路
      t.status = st0.status || 'idle';
      t.schedule = (st0.schedule || []).map(s => ({
        stationId: s.stationId,
        action: ['load', 'unload', 'none'].includes(s.action) ? s.action : 'none',
      }));
      t.schedIndex = st0.schedIndex || 0;
      t.destStationId = st0.destStationId || null;
      t.cargo = (st0.cargo && st0.cargo.length)
        ? st0.cargo.map(s => ({ type: s.type || null, count: s.count || 0, cap: s.cap || FG.Config.TRAIN_SLOT_CAP }))
        : t.cargo;
      t.dwellTicks = st0.dwellTicks || 0;
      t.idleTicks = st0.idleTicks || 0;
      t.lastCargo = st0.lastCargo || 0;
      t.px = st0.x; t.py = st0.y;
      this.trains.push(t);
      // 读档时正停在计划站上 → 恢复停站装卸态（货厢/调度计数已恢复，机械臂立即可用）
      const target = this.stationById(t.destStationId);
      if (target && target.x === t.x && target.y === t.y) t.mode = 'dwell';
    }
    // id 序号不与现有列车冲突
    for (const t of this.trains) {
      const n = parseInt(String(t.id).replace(/^T/, ''), 10);
      if (!isNaN(n)) this.seq = Math.max(this.seq, n + 1);
    }
    this.markDirty();
  }
};

function edgeKey(x1, y1, x2, y2) {
  const a = FG.Utils.key(x1, y1), b = FG.Utils.key(x2, y2);
  return a < b ? a + '|' + b : b + '|' + a;
}

function dirFromTo(fx, fy, tx, ty) {
  const dx = Math.sign(tx - fx), dy = Math.sign(ty - fy);
  for (let d = 0; d < 4; d++) {
    const v = FG.Utils.dirVec(d);
    if (v.x === dx && v.y === dy) return d;
  }
  return 0;
}
