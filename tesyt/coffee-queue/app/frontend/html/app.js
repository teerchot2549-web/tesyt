// ===== Coffee Queue: ตั้งค่าส่วนกลางของหน้าเว็บ =====
// ทุกหน้าเรียก Backend ผ่าน /api (Nginx ส่งต่อให้ container backend)
// ถ้า endpoint หรือชื่อฟิลด์ของ Backend เปลี่ยน แก้ที่ไฟล์นี้ไฟล์เดียวได้เลย
const API = '/api';

const ENDPOINTS = {
  menu:        () => '/menu',                                   // GET  -> [{id,name,price}]
  createOrder: () => '/orders',                                 // POST {name, items:[{drink,temp,quantity}]} -> {queue,items,total,...}
  getOrder:    (q) => '/orders/' + encodeURIComponent(q),       // GET  -> {queue,status,name,items,total}
  staffOrders: () => '/staff/orders',                           // GET  (header X-Staff-PIN) -> [order,...]
  setStatus:   (q) => '/orders/' + encodeURIComponent(q) + '/status', // PATCH {status} (header X-Staff-PIN)
  qr:          (q) => '/orders/' + encodeURIComponent(q) + '/qr',      // GET  -> รูป SVG ของ QR จ่ายเงิน (ใช้เป็น <img src>)
  slip:        (q) => '/orders/' + encodeURIComponent(q) + '/slip',    // POST {slip: "data:image/..."} ลูกค้าแนบสลิป
  staffSlip:   (q) => '/staff/orders/' + encodeURIComponent(q) + '/slip', // GET -> {slip} (header X-Staff-PIN)
  callAgain:   (q) => '/orders/' + encodeURIComponent(q) + '/call',    // POST (header X-Staff-PIN) เรียกลูกค้าซ้ำ -> {calls}
  setPayment:  (q) => '/orders/' + encodeURIComponent(q) + '/payment', // PATCH {payment:"paid"|"unpaid"} (header X-Staff-PIN)
};

// key = ค่าสถานะที่ Backend เก็บ, label = ชื่อสถานะที่แสดง, desc = คำอธิบายสั้นใต้ชื่อ
// act = ข้อความบนปุ่มของพนักงานตอนเลื่อนออร์เดอร์ "ไปยัง" สถานะนั้น
const STATUSES = [
  { key: 'waiting', label: 'In queue',   desc: 'Paid, waiting for the barista', icon: '🕒', act: 'In queue' },
  { key: 'making',  label: 'Being made', desc: 'Making now',     icon: '☕', act: 'Start' },
  { key: 'ready',   label: 'Ready',      desc: 'Pick it up at the counter', icon: '✅', act: 'Done' },
  { key: 'done',    label: 'Picked up',  desc: 'Enjoy!',         icon: '🛍️', act: 'Picked up' },
];

// เมนูสำรองเมื่อเรียก /api/menu ไม่ได้ (ราคาเป็นบาทต่อแก้ว)
const DEFAULT_MENU = [
  { name: 'Latte', price: 60 },
  { name: 'Americano', price: 50 },
  { name: 'Cappuccino', price: 60 },
  { name: 'Mocha', price: 65 },
  { name: 'Thai Tea', price: 45 },
  { name: 'Green Tea Latte', price: 55 },
  { name: 'Cocoa', price: 50 },
  { name: 'Chocolate', price: 55 },
];

// ===== ตัวช่วย =====
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
function statusIndex(s) {
  const n = norm(s);
  return STATUSES.findIndex((x) => norm(x.key) === n);
}
const queueOf = (o) => o.queue ?? o.queueNumber ?? o.queue_number ?? o.id;
const tempLabel = (t) => (norm(t) === 'hot' ? 'Hot' : 'Iced');
const baht = (n) => '฿' + Number(n).toLocaleString('en-US');

// ออร์เดอร์หนึ่งมีได้หลายรายการ: order.items = [{drink, temp, quantity}]
// รองรับรูปแบบเดิม (drink/temp/quantity ที่ระดับออร์เดอร์) ด้วย
function itemsOf(o) {
  if (Array.isArray(o.items) && o.items.length) return o.items;
  return o.drink ? [{ drink: o.drink, temp: o.temp, quantity: o.quantity ?? 1 }] : [];
}
function fillItems(ul, o) {
  ul.replaceChildren();
  itemsOf(o).forEach((it) => {
    ul.append(el('li', {},
      el('span', { class: 'nm' }, String(it.drink), it.temp ? el('span', { class: 'tp', text: ' ' + tempLabel(it.temp) }) : ''),
      el('span', { class: 'qty', text: '× ' + (it.quantity ?? 1) })));
  });
}
// ยอดรวมของออร์เดอร์จาก Backend (ถ้ามี): total, totalPrice หรือ total_price
const priceOf = (o) => o.total ?? o.totalPrice ?? o.total_price ?? null;

async function api(path, { method = 'GET', body, pin } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (pin) headers['X-Staff-PIN'] = pin;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw Object.assign(new Error("Can't reach the server. Please try again."), { status: 0 });
  }
  if (!res.ok) {
    let msg = 'Something went wrong (' + res.status + ')';
    try {
      const j = await res.json();
      if (j && (j.message || j.error)) msg = j.message || j.error;
    } catch (e) { /* ignore */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  if (res.status === 204) return null;
  try { return await res.json(); } catch (e) { return null; }
}

// สร้าง DOM แบบปลอดภัย (ใช้ textContent ไม่ใช้ innerHTML กับข้อมูลลูกค้า)
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => n.append(c));
  return n;
}
function showMsg(box, text, type) {
  box.textContent = text || '';
  box.className = text ? 'msg ' + (type || 'err') : 'msg hidden';
}

// ===== การชำระเงิน (PromptPay): unpaid -> slip (แนบสลิปแล้ว รอพนักงานตรวจ) -> paid =====
const PAY = { unpaid: 'Unpaid', slip: 'Checking slip', paid: 'Paid ✓' };
// ถ้า Backend ไม่ส่ง payment มา (เวอร์ชันเก่า) ถือว่าจ่ายแล้ว เพื่อให้หน้าเว็บยังใช้งานได้
const payOf = (o) => (PAY[o.payment] ? o.payment : 'paid');

// ===== แจ้งเตือน: เสียง / สั่น / ป๊อปอัป =====
let audioCtx = null;
function audio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { /* เบราว์เซอร์ไม่รองรับเสียง */ }
  return audioCtx;
}
addEventListener('pointerdown', () => audio(), { once: true }); // เบราว์เซอร์ให้เล่นเสียงได้หลังผู้ใช้แตะหน้าจอครั้งแรก
function beep(times = 2) {
  const ac = audio();
  if (!ac) return;
  for (let i = 0; i < times; i++) {
    const t = ac.currentTime + i * 0.28, o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + 0.25);
  }
}
const buzz = () => { try { if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 400]); } catch (_) {} };

// แถบแจ้งเตือนเล็กๆ ด้านล่างจอ (กดเพื่อปิด)
let toastTimer = null;
function toast(text, onClick) {
  let t = document.getElementById('toast');
  if (!t) { t = el('button', { id: 'toast', class: 'toast hidden', type: 'button' }); document.body.append(t); }
  t.textContent = text;
  t.onclick = () => { t.classList.add('hidden'); if (onClick) onClick(); };
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 8000);
}

// ป๊อปอัปกลางจอ: คืนฟังก์ชันปิด (กดพื้นหลังหรือ Esc ก็ปิดได้)
function modal(...kids) {
  const ov = el('div', { class: 'overlay' }, el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, ...kids));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  const first = ov.querySelector('button');
  if (first) first.focus();
  return close;
}

// ===== สลิป =====
// ย่อรูปก่อนส่ง (ด้านยาวไม่เกิน 900px, JPEG) ให้ไฟล์เล็กและอัปโหลดเร็ว
function slipFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Can't read that image. Try a PNG or JPG photo of the slip.")); };
    img.src = url;
  });
}
// สลิปตัวอย่างสำหรับทดสอบระบบ (วาดขึ้นเอง ไม่ใช่สลิปจริง)
function sampleSlip(order) {
  const c = document.createElement('canvas');
  c.width = 360; c.height = 520;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 360, 520);
  x.fillStyle = '#123D2F'; x.fillRect(0, 0, 360, 86);
  x.fillStyle = '#fff'; x.font = '600 26px sans-serif'; x.fillText('Transfer complete', 24, 54);
  [['Amount', baht(priceOf(order) ?? 0)], ['To', 'PromptPay · Coffee Queue'], ['Ref', 'SAMPLE-' + queueOf(order)],
   ['Date', new Date().toLocaleString('en-GB')]].forEach(([k, v], i) => {
    x.fillStyle = '#5F7369'; x.font = '16px sans-serif'; x.fillText(k, 24, 140 + i * 64);
    x.fillStyle = '#14251E'; x.font = '600 20px sans-serif'; x.fillText(v, 24, 168 + i * 64);
  });
  x.fillStyle = '#D7263D'; x.font = '700 20px sans-serif'; x.fillText('SAMPLE SLIP · demo only', 24, 470);
  return c.toDataURL('image/jpeg', 0.8);
}
