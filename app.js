// ポール貸出（カメラ）
// スマホのカメラで利用者カード（C0001…）とポール（P001…）のバーコードを読み、
// 貸出・返却の判断と記録は Google Apps Script（名簿のスプレッドシート）が行う。
// このページには暗証番号も個人情報も置かない。暗証番号はログインの1回だけ送り、あとは12時間で切れる合言葉で通信する。
'use strict';

const API = 'https://script.google.com/macros/s/AKfycbzJQusF-uUzLrn8ASz1siqqwsW17gMjT6rfE2vd-7UvN6h3TatKkfa9GX1eAd49z6Ox/exec';
const PIN_LEN = 6;
const SAME_CODE_MS = 3000;   // 同じ番号は、最後に映ってから3秒たつまで読み直さない

let token = '', member = null, pinBuf = '', reader = null, lastCode = '', lastAt = 0, idleTimer = null;
const queue = [];
let working = false;

const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- 通信 ----
// text/plain で送ると、ブラウザの事前確認（preflight）なしで Apps Script に届く
async function api(action, body) {
  $('busy').style.display = 'block';
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, token }, body || {})),
      redirect: 'follow',
      credentials: 'omit',
    });
    const j = await res.json();
    if (!j.ok) {
      if (/暗証番号を入れて/.test(j.error)) { saveToken(''); stopCamera(); pinView(j.error); }
      throw new Error(j.error);
    }
    return j.data !== undefined ? j.data : j;
  } finally {
    $('busy').style.display = 'none';
  }
}

function saveToken(t) {
  token = t;
  try { t ? localStorage.setItem('tok', JSON.stringify({ t, until: Date.now() + 11.5 * 3600 * 1000 })) : localStorage.removeItem('tok'); } catch (e) {}
}
function loadToken() {
  try { const o = JSON.parse(localStorage.getItem('tok') || 'null'); if (o && o.until > Date.now()) return o.t; } catch (e) {}
  return '';
}

// 読めた・読めなかったを音と振動で知らせる
function beep(ok) {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = ok ? 1200 : 300; o.connect(g); g.connect(a.destination); g.gain.value = 0.15;
    o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.4));
  } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch (e) {}
}

// ---- 暗証番号 ----
function pinView(msg) {
  $('app').innerHTML = `<header><b>ポール貸出（カメラ）</b></header><div class="wrap">
    <div id="msg">受付係の暗証番号（${PIN_LEN}桁）<br>${esc(pinBuf.padEnd(PIN_LEN, '・'))}</div>
    <div style="color:#b00020;text-align:center;margin-top:6px">${esc(msg || '')}</div>
    <div class="pad" id="pad"></div></div>`;
  [1, 2, 3, 4, 5, 6, 7, 8, 9, '消す', 0, ''].forEach(k => {
    const b = document.createElement('button'); b.textContent = k; b.onclick = () => pinKey(String(k)); $('pad').appendChild(b);
  });
}
async function pinKey(k) {
  if (k === '消す') pinBuf = pinBuf.slice(0, -1); else if (k !== '' && pinBuf.length < PIN_LEN) pinBuf += k;
  if (pinBuf.length < PIN_LEN) return pinView();
  const pin = pinBuf; pinBuf = '';
  try { const r = await api('login', { pin }); saveToken(r.token); main(); }
  catch (e) { pinView(e.message); }
}

// ---- カメラ ----
function startCamera() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.QR_CODE]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  reader = new ZXing.BrowserMultiFormatReader(hints, 200);
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };
  reader.decodeFromConstraints(constraints, $('video'), (result) => { if (result) onCode(result.getText()); })
    .then(() => { const o = $('camoff'); if (o) o.remove(); })
    .catch(e => {
      const o = $('camoff');
      if (o) o.innerHTML = 'カメラを使えませんでした。<br>ブラウザの設定でカメラを許可するか、下の欄に番号を打ってください';
    });
}
function stopCamera() { try { reader && reader.reset(); } catch (e) {} reader = null; }

// カメラは映っているあいだ何度も読むので、同じ番号は「枠から外れて3秒たつ」までは1回とみなす。
// （ポールを枠に入れたままにしても、貸出→返却→貸出…と切り替わらないように）
function onCode(code, typed) {
  code = String(code).trim().toUpperCase();
  const now = Date.now();
  if (!typed && code === lastCode && now - lastAt < SAME_CODE_MS) { lastAt = now; return; }
  lastCode = code; lastAt = now;
  queue.push(code);
  if (!working) work();
}

// ---- 貸出・返却 ----
function main() {
  $('app').innerHTML = `<header><b>ポール貸出・返却</b><button id="btnList">まだ返っていない一覧</button></header><div class="wrap">
    <div id="cam"><video id="video" playsinline muted></video><div class="guide"></div><div class="off" id="camoff">カメラを起動しています…</div></div>
    <div id="msg">利用者カードか、ポールを枠に入れてください</div>
    <div class="box" id="who" style="display:none"><div style="display:flex;justify-content:space-between;align-items:center"><div class="n" id="wn"></div><button class="s" id="btnDone">終わり</button></div><div class="p" id="wp"></div></div>
    <div class="row"><input id="code" placeholder="番号を手で打つ（例 C0001・P001）" autocomplete="off" autocapitalize="characters"><button class="g" id="btnGo">送る</button></div>
    <div id="log"></div></div>`;
  $('btnList').onclick = listView;
  $('btnDone').onclick = clearMember;
  $('btnGo').onclick = () => { const v = $('code').value; $('code').value = ''; if (v.trim()) onCode(v, true); };
  $('code').onkeydown = e => { if (e.key === 'Enter') $('btnGo').click(); };
  if (member) setMember(member);
  startCamera();
}

function show(cls, html) { const m = $('msg'); if (m) { m.className = cls; m.innerHTML = html; } }
function log(text) { const l = $('log'); if (!l) return; l.insertAdjacentHTML('afterbegin', `<div>${new Date().toTimeString().slice(0, 5)}　${esc(text)}</div>`); while (l.children.length > 8) l.lastChild.remove(); }

function setMember(m) {
  member = m;
  const w = $('who');
  if (w) {
    w.style.display = m ? 'block' : 'none';
    if (m) { $('wn').textContent = m.name + ' さん'; $('wp').textContent = m.poles.length ? '借りているポール：' + m.poles.join('、') : '借りているポールはありません'; }
  }
  clearTimeout(idleTimer);
  if (m) idleTimer = setTimeout(clearMember, 90 * 1000);   // 90秒なにも読まなければ次の人へ
}
function clearMember() { setMember(null); show('', '利用者カードか、ポールを枠に入れてください'); }

// 読んだ番号は順番待ちの列に入れて1つずつ処理する（カード→ポールの順が崩れないように）
async function work() {
  working = true;
  while (queue.length) await handle(queue.shift());
  working = false;
}
async function handle(code) {
  try {
    const r = await api('scan', { code, member: member ? member.id : '' });
    if (r.kind === 'member') { setMember(r); show('ok', `${esc(r.name)} さん<small>続けてポールを読んでください</small>`); beep(true); }
    else if (r.kind === 'newcard') { queue.length = 0; beep(true); newCardView(r.card); }
    else if (r.kind === 'lent') { setMember({ id: member.id, name: r.name, poles: r.poles }); show('ok', `貸出　${esc(r.pole)}（2本1組）<small>${esc(r.name)} さん</small>`); log(`貸出 ${r.pole} → ${r.name}`); beep(true); }
    else if (r.kind === 'returned') { show('back', `返却　${esc(r.pole)}<small>${esc(r.name)} さんから</small>`); log(`返却 ${r.pole} ← ${r.name}`); beep(true); if (member) setMember(Object.assign({}, member, { poles: member.poles.filter(p => p !== r.pole) })); }
    else { show('ng', esc(r.msg)); beep(false); }
  } catch (e) {
    if (!/暗証番号/.test(e.message)) { show('ng', `記録できませんでした（${esc(code)}）<small>電波を確認して、もう一度読んでください</small>`); beep(false); }
  }
}

// ---- 初めてのカード：名簿の人とひも付ける ----
function newCardView(card) {
  stopCamera();
  setMember(null);
  $('app').innerHTML = `<header><b>新しいカード ${esc(card)}</b><button id="btnBack">やめる</button></header><div class="wrap">
    <div id="msg">このカードはまだ誰にもひも付いていません<small>持ち主を選んでください</small></div>
    <div class="box"><div class="p">申込ずみの人：電話番号の下4桁</div>
      <div class="row"><input id="l4" inputmode="numeric" maxlength="4" autocomplete="off"><button class="g" id="btnFind">探す</button></div>
      <div id="cands"></div></div>
    <div class="box"><div class="p">名簿にいない人：その場で登録</div>
      <div class="row"><input id="nn" placeholder="お名前" autocomplete="off"></div>
      <div class="row"><input id="np" placeholder="電話番号" inputmode="tel" autocomplete="off"></div>
      <div class="row"><input id="nm" placeholder="メールアドレス（なくてもよい）" inputmode="email" autocomplete="off"></div>
      <div class="row"><button class="g" id="btnReg">登録してカードをひも付ける</button></div></div></div>`;
  $('btnBack').onclick = main;
  $('btnFind').onclick = async () => {
    const l4 = $('l4').value.replace(/\D/g, '');
    if (l4.length !== 4) { show('ng', '下4桁を入れてください'); return; }
    let list;
    try { list = await api('find', { last4: l4 }); } catch (e) { show('ng', esc(e.message)); return; }
    const c = $('cands');
    c.innerHTML = list.length ? '' : '<div style="padding:8px 0">見つかりません。下の「その場で登録」を使ってください</div>';
    list.forEach(x => {
      const d = document.createElement('div'); d.className = 'cand';
      d.innerHTML = `<span>${esc(x.name)}${x.card ? `<small>　（前のカード ${esc(x.card)} は使えなくなります）</small>` : ''}</span>`;
      const b = document.createElement('button'); b.className = 'g'; b.textContent = 'この人';
      b.onclick = async () => { try { done(await api('link', { card, id: x.id })); } catch (e) { show('ng', esc(e.message)); beep(false); } };
      d.appendChild(b); c.appendChild(d);
    });
  };
  $('btnReg').onclick = async () => {
    const n = $('nn').value, p = $('np').value, m = $('nm').value;
    if (!n.trim() || p.replace(/\D/g, '').length < 10) { show('ng', 'お名前と電話番号を入れてください'); beep(false); return; }
    try { done(await api('reglink', { card, name: n, phone: p, mail: m })); } catch (e) { show('ng', esc(e.message)); beep(false); }
  };
}
function done(r) {
  member = { id: r.id, name: r.name, card: r.card, poles: r.poles };
  main();
  show('ok', `${esc(r.card)} を ${esc(r.name)} さんにひも付けました<small>${r.old ? '前のカード ' + esc(r.old) + ' は使えなくなりました。' : ''}続けてポールを読んでください</small>`);
  log(`カード ${r.card} → ${r.name}`);
  beep(true);
}

// ---- まだ返っていない一覧 ----
async function listView() {
  let r;
  try { r = await api('outstanding'); } catch (e) { show('ng', esc(e.message)); return; }
  stopCamera();
  $('app').innerHTML = `<header><b>まだ返っていない（${r.out.length} / ${r.total}組）</b><button id="btnBack">戻る</button></header><div class="wrap">
    ${r.out.length ? `<table><tr><th>ポール</th><th>借りている人</th><th>貸した時刻</th></tr>${r.out.map(x => `<tr><td>${esc(x.pole)}</td><td>${esc(x.name)}</td><td>${esc(x.since)}</td></tr>`).join('')}</table>`
      : '<div id="msg" class="ok">全部返ってきています</div>'}</div>`;
  $('btnBack').onclick = main;
}

// 起動：12時間以内にログインしていれば、そのまま使う
token = loadToken();
if (token) main(); else pinView();
