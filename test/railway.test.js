/**
 * 铁路货运测试：node test/railway.test.js
 * 覆盖：闭塞分区切分（岔路/信号）、运输计划装货→行驶→卸货、信号争用等待、
 *       堵站等待、断路停车与修复恢复、拆除保料、存档保存在途货物与调度状态。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/sim.js',
  'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js', 'js/game/blueprint.js',
  'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

const game = new FG.Game();
const W = 40, H = 30;
const terrain = Array.from({ length: H }, () => Array(W).fill('grass'));
const ores = Array.from({ length: H }, () => Array(W).fill(null));
game.startWithMap({
  presetId: 'greenfield', biome: 'grass', w: W, h: H, seed: 1, sizeId: 'medium',
  terrain, ores, water: new Set(), oil: new Set(),
}, null, 'rail-test');
// 注意：startWithMap 会替换 map 对象，以下为可变引用，每节测试前刷新
let m = game.map, rw = game.railway;
function refreshRefs() { m = game.map; rw = game.railway; }

function P(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  m.register(b);
  if (b.def.station) rw.registerStation(b);
  if (b.def.rail || b.def.station || b.def.signal) rw.markDirty();
  return b;
}
function railLine(x0, y0, x1, y1) {
  const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
  let x = x0, y = y0;
  while (x !== x1 || y !== y1) { P('rail', x, y); x += dx; y += dy; }
  P('rail', x1, y1);
}
function blockId(x, y) { return rw.blockAt(x, y); }
/** 开一张全新空地图（铁路每节测试隔离） */
function newMap(seed) {
  game.startWithMap({
    presetId: 'greenfield', biome: 'grass', w: W, h: H, seed, sizeId: 'medium',
    terrain: terrain.map(r => r.slice()), ores, water: new Set(), oil: new Set(),
  }, null, 'rt' + seed);
  refreshRefs();
}
function trainAt(x, y) { return rw.trainAtTile(x, y); }

console.log('\n[1] 闭塞分区：直线同区、岔路/站点独立成区、信号切断边界');
{
  railLine(2, 5, 12, 5);            // 纯直道
  P('rail', 13, 5);
  P('trainStop', 14, 5);            // 车站接在直道末端
  P('rail', 7, 6); P('rail', 7, 7); // 在 (7,5) 向南岔出
  ticks(game, 2);                    // railway.tick 触发分区重建
  // 信号切边要放在没有岔路/站点的直道段：(4,4) 朝南，A=(4,5)，B=(5,5)
  const sig0 = P('railSignal', 4, 4, 2);
  ticks(game, 1);
  ok(!!blockId(2, 5) && blockId(2, 5) === blockId(3, 5) && blockId(3, 5) === blockId(4, 5),
    '直线轨道同一闭塞分区（信号以西）');
  ok(blockId(4, 5) !== blockId(5, 5), '信号切断所对轨道边（两侧不同分区）');
  const ahead0 = rw.signalAhead(sig0);
  ok(ahead0.valid && ahead0.train === null, '信号前方空闲 → 绿灯');
  ok(blockId(5, 5) === blockId(6, 5), '信号东侧直道仍同区');
  ok(blockId(14, 5) !== blockId(13, 5), '火车站独立成区');
  ok(blockId(7, 5) !== blockId(6, 5) && blockId(7, 5) !== blockId(8, 5), '岔路口节点（邻接≥3）独立成区');
  ok(blockId(7, 6) === blockId(7, 7), '岔路支路同侧同区');
  // 信号前方分区被占用 → 红灯
  const hold = rw.createTrain(6, 5);
  rw.trains.push(hold);
  const occBk = blockId(6, 5);
  rw.occupant.set(occBk, hold.id);
  const ahead1 = rw.signalAhead(sig0);
  ok(ahead1.train === hold, '前方分区有列车时信号变红');
  rw.removeTrain(hold);
}

console.log('\n[2] 运输计划：装货站 → 列车自动行驶 → 卸货站，机械臂完成装/卸');
{
  newMap(2);
  // 直线：装货站 (3,10) — 轨道(4..19) — 卸货站 (20,10)
  P('trainStop', 3, 10);
  railLine(4, 10, 19, 10);
  const sA = m.buildingAt(3, 10); sA.stationName = '铁矿装料站';
  const sB = P('trainStop', 20, 10); sB.stationName = '熔炉卸货站';
  ticks(game, 1);

  // 装货站北侧：箱子(3,8) → 机械臂(3,9)朝南 → 车站格(3,10)上的停站列车
  const chestA = P('chest', 3, 8);
  chestA.chest[0] = { type: 'ironOre', count: 200, cap: FG.Config.CHEST_SLOT_CAP };
  const armLoad = P('inserter', 3, 9, 2);
  ok(armLoad && armLoad.type === 'inserter', '装货臂就位（箱子→臂→车站）');

  // 卸货站：车站(20,10) → 臂(20,11)朝南 → 箱子(20,12)
  P('inserter', 20, 11, 2);
  const chestB = P('chest', 20, 12);

  // 列车放在装货站
  const t = rw.addTrain(3, 10);
  ok(!!t, '列车在装货站放置成功');
  t.schedule = [
    { stationId: sA.stationId, action: 'load' },
    { stationId: sB.stationId, action: 'unload' },
  ];
  t.schedIndex = 0;
  // 已在站上 → 直接进装卸停靠
  rw.dispatchNext(t);
  ok(t.mode === 'dwell' && t.x === 3 && t.y === 10, '首站为当前格 → 立即停站装货');

  // 装货：机械臂装 80 tick（装不满，3 秒无变化后自动发车——箱子持续有料，臂会装满货厢）
  ticks(game, 200);
  const loaded = rw.cargoTotal(t);
  ok(loaded > 0, '机械臂把矿石装入停站列车（' + loaded + ' 件）');
  ok(t.mode !== 'dwell' || loaded >= FG.Config.TRAIN_SLOTS * FG.Config.TRAIN_SLOT_CAP,
    '装满后自动发车（mode=' + t.mode + '，货=' + loaded + '）');

  // 行驶到卸货站（17 格，巡航约 0.12 格/tick，给足时间）
  ticks(game, 600);
  ok(t.x === 20 && t.y === 10 && t.mode === 'dwell', '列车按运输计划到达卸货站停靠（' + t.x + ',' + t.y + ' mode=' + t.mode + '）');

  // 卸货
  ticks(game, 300);
  const got = chestB.chest.find(s => s.type === 'ironOre');
  ok(got && got.count > 0, '到站矿石由机械臂卸入箱子（' + (got ? got.count : 0) + ' 件），接入产线供料');
  ok(rw.cargoTotal(t) === 0, '卸货模式卸空后货厢清空');
}

console.log('\n[3] 堵站：目的站被占用时后车在站外等待，前车离开后自动进站');
{
  newMap(3);
  railLine(5, 15, 17, 15);
  const st = P('trainStop', 18, 15);
  ticks(game, 1);
  // 前车直接停在站上（空计划，靠测试驱动到 dwell）
  const t1 = rw.addTrain(18, 15);
  t1.schedule = [{ stationId: st.stationId, action: 'none' }];
  t1.schedIndex = 0;
  rw.dispatchNext(t1);
  ok(t1.mode === 'dwell', '前车在站装卸中（占用站分区）');

  // 后车从 (5,15) 出发去同一站
  const t2 = rw.addTrain(5, 15);
  t2.schedule = [{ stationId: st.stationId, action: 'none' }];
  t2.schedIndex = 0;
  rw.dispatchNext(t2);
  ticks(game, 500);
  ok(t2.x < 18, '后车未闯入被占用的车站（停在 x=' + t2.x + '）');
  ok(t2.status === 'blocked', '后车状态为等待（堵站）');
  ok(t1.x === 18 && t2.x !== t1.x, '两车未重叠（前车 18，后车 ' + t2.x + '）');

  // 前车拆走 → 后车自动进站
  rw.removeTrain(t1);
  ticks(game, 500);
  ok(t2.x === 18 && t2.y === 15, '堵站解除后后车自动进站（x=' + t2.x + ' mode=' + t2.mode + '）');
}

console.log('\n[4] 信号争用：前方分区被占用时红灯停车，分区释放后继续行驶');
{
  newMap(4);
  // 环线（10 格 × 6 格矩形），四角之一放车站，两个信号把环切成多个分区
  const st1 = P('trainStop', 4, 4);  // 环角车站（本身是轨道节点）
  railLine(5, 4, 14, 4);
  railLine(14, 4, 14, 10);
  railLine(14, 10, 4, 10);
  railLine(4, 10, 4, 5);
  // 信号：(9,3) 朝南，A=(9,4) B=(10,4)，切断环边
  const sig = P('railSignal', 9, 3, 2);
  P('railSignal', 9, 11, 0); // 对称另一侧
  ticks(game, 1);
  const sigInfo = rw.signalAhead(sig);
  ok(sigInfo.valid, '信号朝向有效（正对环线轨道）');
  ok(blockId(9, 4) !== blockId(10, 4), '信号把环线切成两个闭塞分区');

  // 两车环行（计划只有一个站，循环跑圈）
  const t1 = rw.addTrain(4, 4);
  t1.schedule = [{ stationId: st1.stationId, action: 'none' }];
  t1.schedIndex = 0; rw.dispatchNext(t1);
  ticks(game, 5); // 让前车先离站
  const t2 = rw.addTrain(5, 4);
  t2.schedule = [{ stationId: st1.stationId, action: 'none' }];
  t2.schedIndex = 0; rw.dispatchNext(t2);

  let overlap = false;
  for (let i = 0; i < 1500; i++) {
    game.tickOnce();
    const a = FG.Utils.key(t1.x, t1.y), b = FG.Utils.key(t2.x, t2.y);
    if (a === b) { overlap = true; break; }
    if (rw.trainAtTile(t1.x, t1.y) !== t1 || rw.trainAtTile(t2.x, t2.y) !== t2) { overlap = true; break; }
  }
  ok(!overlap, '环线上两列车全程无碰撞/重叠（闭塞信号生效）');
  ok(t1.x !== t2.x || t1.y !== t2.y, '两车在环上保持间隔运行');
}

console.log('\n[5] 断路：轨道中断 → noPath 停车；接通后自动恢复行驶');
{
  newMap(5);
  railLine(5, 20, 10, 20);
  railLine(14, 20, 19, 20);   // 11..13 断开
  const st = P('trainStop', 20, 20);
  ticks(game, 1);
  const t = rw.addTrain(5, 20);
  t.schedule = [{ stationId: st.stationId, action: 'none' }];
  t.schedIndex = 0;
  rw.dispatchNext(t);
  ticks(game, 30);
  ok(t.mode === 'noPath', '断路时列车进入 noPath 状态停车（mode=' + t.mode + '）');
  const edgeX = t.x;
  // 接通
  railLine(10, 20, 14, 20);
  ticks(game, 400);
  ok(t.x === 20 && t.y === 20, '轨道修复后列车自动重新寻路到站（断点 x=' + edgeX + ' → ' + t.x + '）');
}

console.log('\n[6] 拆轨/拆车物料保留：占用轨道不可拆；列车拆除货落地面堆');
{
  newMap(6);
  railLine(6, 6, 12, 6);
  const t = rw.addTrain(6, 6);
  rw.cargoAdd(t, 'coal', 15);
  const railB = m.buildingAt(6, 6);
  game.removeBuilding(railB);
  ok(m.buildingAt(6, 6), '列车占用的轨道格禁止拆除');
  game.removeBuilding(t);
  const pile = m.pileAt(6, 6);
  const coal = pile && pile.find(s => s.type === 'coal');
  ok(coal && coal.count === 15, '拆除列车后货厢 15 件煤炭落到地面堆保留');
  game.removeBuilding(m.buildingAt(6, 6));
  ok(!m.buildingAt(6, 6), '列车移走后轨道可以拆除');
}

console.log('\n[7] 存档：运输中的货物与调度状态序列化，读档后继续运行');
{
  newMap(7);
  const sA = P('trainStop', 5, 8); sA.stationName = '装料站';
  railLine(6, 8, 19, 8);
  const sB = P('trainStop', 20, 8); sB.stationName = '卸料站';
  P('inserter', 20, 9, 2);
  const outChest = P('chest', 20, 10);
  ticks(game, 1);
  const t = rw.addTrain(5, 8);
  t.schedule = [
    { stationId: sA.stationId, action: 'load' },
    { stationId: sB.stationId, action: 'unload' },
  ];
  t.schedIndex = 0;
  rw.dispatchNext(t);
  rw.cargoAdd(t, 'copperPlate', 60);
  rw.endDwell(t);
  ticks(game, 30);  // 行驶中途
  const midX = t.x, midCargo = rw.cargoTotal(t);

  const data = JSON.parse(JSON.stringify(game.serialize()));
  ok(data.railway && data.railway.trains.length === 1, '存档包含铁路数据');
  ok(data.railway.trains[0].cargo.some(s => s.type === 'copperPlate' && s.count === 60),
    '运输中的货物（60 铜板）已保存');
  ok(JSON.stringify(data.railway.trains[0].schedule).includes('load'),
    '运输计划（装/卸站点与动作）已保存');
  const savedB = data.buildings.find(b => b.type === 'trainStop' && b.x === 20);
  ok(savedB && savedB.stationName === '卸料站' && savedB.stationId, '火车站 id/名称随建筑存档');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const t2 = g2.railway.trains[0];
  ok(!!t2, '读档后列车恢复');
  const cargo = g2.railway.cargoTotal(t2);
  ok(cargo === 60, '在途货物数量恢复（60，实际 ' + cargo + '）');
  ok(t2.schedule.length === 2 && t2.schedule[0].action === 'load', '运输计划恢复');
  // 继续跑到卸货站并卸入箱子
  for (let i = 0; i < 800; i++) {
    g2.tickOnce();
    if (t2.x === 20 && t2.y === 8 && g2.railway.cargoTotal(t2) === 0) break;
  }
  const got = outChest && g2.map.buildingAt(20, 10).chest.find(s => s.type === 'copperPlate');
  ok(got && got.count === 60, '读档后列车继续行驶到站并卸完全部 60 件（实际 ' + (got ? got.count : 0) + '）');

  // 旧存档兼容：无 railway 字段
  delete data.railway;
  const g3 = new FG.Game();
  let err = null;
  try { g3.deserialize(data); g3.tickOnce(); g3.tickOnce(); } catch (e) { err = e; }
  ok(!err, '无铁路字段的旧存档读取与仿真不报错' + (err ? '：' + err.stack : ''));
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
