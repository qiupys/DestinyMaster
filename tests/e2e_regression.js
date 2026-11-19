/**
 * Destiny Master 全量端到端回归测试
 * ------------------------------------------------------------------
 * 覆盖：注册 / 登录 / 五功能排盘与 AI 解读 / 追问 / 切页后台继续 /
 *       提问状态保留 / 个人中心（用户名·密码文案、历史、日期查找） / 管理员。
 * 每个关键状态自动截图到 tests/screenshots/<RUN_ID>_*.png。
 *
 * 用法：
 *   NODE_PATH=<playwright 所在 node_modules> node tests/e2e_regression.js
 *
 * 可选环境变量：
 *   BASE_URL          门户地址（默认 http://localhost:8899；线上运行设为实际地址）
 *   ZIWEI_ADMIN_KEY   管理员口令；提供则测试管理员登录并执行临时账号清理，
 *                     不提供则只验证管理入口存在（口令不入库，仅运行时注入）。
 *
 * 说明：临时账号名/密码每次随机生成，测试结束若提供 ADMIN_KEY 会自动删除。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:8899';
const ADMIN_KEY = process.env.ZIWEI_ADMIN_KEY || '';
const SHOT_DIR = path.join(__dirname, 'screenshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const USER = 'e2e_' + Date.now().toString(36);
const PASS = 'E2e@' + Math.random().toString(36).slice(2, 10);
const AI_TIMEOUT = 120000; // 单次 AI 解读最长等待

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function ok(name, detail) { results.push({ name, status: 'PASS', detail: detail || '' }); console.log('  PASS ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail: detail || '' }); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
function info(name, detail) { results.push({ name, status: 'INFO', detail: detail || '' }); console.log('  INFO ' + name + (detail ? ' — ' + detail : '')); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

async function shot(page, name) {
  try {
    const file = path.join(SHOT_DIR, RUN_ID + '_' + name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    return path.basename(file);
  } catch (e) { return 'SHOT_FAIL:' + e.message; }
}

/** 等待某容器内新出现的 AI 解读卡完成（卡片加 .done = 流式结束标志） */
async function waitAI(card, timeout) {
  await card.waitFor({ state: 'visible', timeout: timeout || AI_TIMEOUT });
  await pageWaitForDone(card, timeout || AI_TIMEOUT);
}
async function pageWaitForDone(card, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const cls = await card.getAttribute('class').catch(() => '');
    if (cls && /(^|\s)done(\s|$)/.test(cls)) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('等待解读完成超时（.done 未出现）');
}

/** 点击解读按钮后，拿到刚插入的顶层 .p-ai 卡（新提问插在最前） */
function latestCard(page, containerSel) {
  return page.locator(containerSel + ' > .p-ai').first();
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.setDefaultTimeout(20000);

  try {
    section('0. 首页加载');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(700);
    const brand = await page.locator('.p-brand-mark svg').count();
    brand ? ok('品牌 ∞ 图标渲染', 'svg=' + brand) : fail('品牌 ∞ 图标渲染', '未找到 svg');
    await shot(page, '00_home');
    // 默认进入应显示落地首页 + 五大功能入口卡片
    const homeCards = await page.locator('.home-page .home-card').count();
    const crumbHome = await page.locator('#p-crumb').innerText().catch(() => '');
    (homeCards === 5 && crumbHome === '首页') ? ok('默认显示首页与五大入口', 'cards=' + homeCards + ' crumb=' + crumbHome)
      : fail('默认显示首页', 'cards=' + homeCards + ' crumb=' + crumbHome);
    // 点功能卡片进入对应页；再点品牌区应返回首页
    await page.locator('.home-card[data-feature="bazi"]').click();
    await page.waitForTimeout(500);
    const enteredBazi = (await page.locator('#p-crumb').innerText().catch(() => '')) === '八字排盘';
    await page.locator('.p-brand').click();
    await page.waitForTimeout(500);
    const backHome = (await page.locator('.home-page .home-card').count()) === 5;
    (enteredBazi && backHome) ? ok('入口卡片跳转 + 品牌区返回首页', 'enter=' + enteredBazi + ' back=' + backHome)
      : fail('首页跳转/返回', 'enter=' + enteredBazi + ' back=' + backHome);

    section('0b. 未登录 AI 门禁');
    // 未登录进入功能页：应出现门禁卡（锁 + 标题 + 登录按钮），真正的 AI 按钮被隐藏
    await page.goto(BASE + '/?gate=' + Date.now() + '#/tarot', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const gateN = await page.locator('.ai-gate .ag-btn').count();
    const locked = await page.locator('#p-content .stage-locked').count();
    (gateN > 0 && locked > 0) ? ok('未登录显示 AI 登录门禁') : fail('未登录显示 AI 登录门禁', 'gate=' + gateN + ' locked=' + locked);
    await shot(page, '00b_gate');
    // 点门禁按钮应弹登录框
    if (gateN) {
      await page.locator('.ai-gate .ag-btn').first().click();
      await page.waitForTimeout(300);
      const modalOpen = await page.evaluate(() => { const m = document.getElementById('p-modal'); return m && !m.classList.contains('hidden'); });
      modalOpen ? ok('门禁按钮打开登录框') : fail('门禁按钮打开登录框');
      await page.click('#p-modal .p-modal-x').catch(() => {});
      await page.waitForTimeout(200);
    }
    // 黄历：未登录时整张 AI 提问卡（输入框/快捷问题/八字开关）应隐藏，只留门禁卡
    await page.goto(BASE + '/?gateHL=' + Date.now() + '#/huangli', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    const hlGate = await page.evaluate(() => {
      const card = document.querySelector('.hl-ai-card');
      const q = document.querySelector('#hl-q');
      // 父卡 display:none 时子元素 computedStyle 仍为 block，须用 offsetParent 判真实可见性
      return { cardVisible: !!(card && card.offsetParent !== null),
        gate: document.querySelectorAll('#p-stage-huangli .ai-gate .ag-btn').length,
        q: !!(q && q.offsetParent !== null) };
    });
    (!hlGate.cardVisible && !hlGate.q && hlGate.gate > 0)
      ? ok('黄历未登录仅显示门禁卡、隐藏提问卡')
      : fail('黄历未登录隐藏提问卡', JSON.stringify(hlGate));

    // 各功能页：门禁卡、分割行（关于本功能）、内容卡三者宽度应一致（八字720，黄历/紫微760）
    const widthRows = [];
    for (const wf of ['bazi', 'meihua', 'tarot', 'huangli', 'ziwei']) {
      await page.goto(BASE + '/?wid=' + wf + Date.now() + '#/' + wf, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      widthRows.push(await page.evaluate((f) => {
        const st = document.querySelector('#p-stage-' + f);
        const cw = (s) => { const e = st && st.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : null; };
        return { feat: f, gate: cw('.ai-gate-host'), about: cw('.about-details'), card: cw('.tool-card') };
      }, wf));
    }
    const widthOK = widthRows.every(r => r.gate && r.gate === r.about && (!r.card || r.card === r.gate));
    widthOK ? ok('五功能门禁卡/分割行/内容卡宽度统一', JSON.stringify(widthRows))
      : fail('五功能宽度统一', JSON.stringify(widthRows));

    section('1. UI 注册临时账号 ' + USER);
    await page.click('#p-auth-btn');
    await page.waitForTimeout(200);
    await page.click('.p-auth-tabs button[data-t="reg"]');
    await page.waitForTimeout(200);
    await page.fill('#au-name', USER);
    await page.fill('#au-pass', PASS);
    await page.fill('#au-pass2', PASS);
    await shot(page, '01_register_form');
    await page.click('#au-submit');
    // 等待弹层关闭 + 登录态写入
    await page.waitForFunction(() => {
      const m = document.getElementById('p-modal');
      return m && m.classList.contains('hidden') && !!localStorage.getItem('zw-profile');
    }, null, { timeout: 20000 });
    const prof = await page.evaluate(() => JSON.parse(localStorage.getItem('zw-profile') || 'null'));
    (prof && prof.name === USER) ? ok('注册并登录', 'id=' + prof.id) : fail('注册并登录', JSON.stringify(prof));
    await shot(page, '02_logged_in');

    section('2. 八字排盘 + AI 解读（含切页后台继续）+ 追问');
    // 登录态下强制整页重载到八字页（加 query 确保新文档，而非仅 hash 变化）：
    // renderBazi 会据档案出生信息自动排盘（stage 全新）
    await page.goto(BASE + '/?e2e=' + Date.now() + '#/bazi', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#bz-result', { state: 'visible', timeout: 25000 });
    await page.waitForTimeout(800);
    (await page.locator('#bz-result').innerText()).length > 30 ? ok('八字自动排盘') : fail('八字自动排盘');
    await shot(page, '10_bazi_result');
    await page.fill('#bz-q', '请分析这个八字的事业格局与性格特点');
    await page.click('#bz-ai');
    // 立即切到塔罗，验证解读在后台继续
    await page.waitForTimeout(300);
    await page.click('.p-navitem[data-feature="tarot"]');
    await page.waitForTimeout(1200);
    await shot(page, '11_bazi_background_switched');
    await page.click('.p-navitem[data-feature="bazi"]');
    const bzCard = latestCard(page, '#bz-ai-out');
    try {
      await waitAI(bzCard);
      const txt = await bzCard.innerText();
      txt.length > 60 ? ok('切页后 AI 解读在后台继续并完成', 'len=' + txt.length) : fail('切页后台继续', '内容过短');
      // 免责声明只出现一次（前端不再重复追加）
      const disclaimN = (txt.match(/命运始终掌握在自己手中/g) || []).length;
      disclaimN === 1 ? ok('免责声明仅出现一次') : fail('免责声明仅出现一次', '出现 ' + disclaimN + ' 次');
    } catch (e) { fail('切页后 AI 解读在后台继续并完成', e.message.split('\n')[0]); }
    await shot(page, '12_bazi_ai');
    const bzFollow = bzCard.locator('.ai-follow-btn');
    if (await bzFollow.count()) {
      await bzCard.locator('.ai-follow input').fill('再具体说说事业方向');
      await bzFollow.click();
      try {
        const followCard = bzCard.locator('.ai-follow-slot > .p-ai').first();
        await followCard.waitFor({ state: 'visible', timeout: AI_TIMEOUT });
        await pageWaitForDone(followCard, AI_TIMEOUT);
        ok('八字追问', '追问结果已返回');
      } catch (e) { fail('八字追问', e.message.split('\n')[0]); }
      await shot(page, '13_bazi_follow');
    } else fail('八字追问', '未出现追问条（hid 缺失？）');

    section('3. 提问状态保留（切页不抹掉）');
    await page.fill('#bz-q', '这是一条切页保留测试内容');
    await page.click('.p-navitem[data-feature="meihua"]');
    await page.waitForTimeout(300);
    await page.click('.p-navitem[data-feature="bazi"]');
    await page.waitForTimeout(300);
    (await page.inputValue('#bz-q')) === '这是一条切页保留测试内容'
      ? ok('切页后提问框内容保留') : fail('切页后提问框内容保留');

    section('4. 梅花易数（起卦 + AI 解卦 + 追问）');
    // 当前在梅花之前需重新切过去
    await page.click('.p-navitem[data-feature="meihua"]');
    await page.waitForSelector('#mh-q', { state: 'visible' });
    await page.fill('#mh-q', '我是否应该接受这个新的工作机会');
    await page.click('#mh-calc');
    await page.waitForFunction(() => (document.getElementById('mh-result') || {}).innerText?.length > 20, null, { timeout: 15000 });
    ok('梅花起卦', (await page.locator('#mh-result').innerText()).slice(0, 20).replace(/\n/g, ' '));
    await shot(page, '30_meihua_gua');
    await page.click('#mh-ai');
    const mhCard = latestCard(page, '#mh-result');
    try { await waitAI(mhCard); ok('梅花 AI 解卦', 'len=' + (await mhCard.innerText()).length); }
    catch (e) { fail('梅花 AI 解卦', e.message.split('\n')[0]); }
    await shot(page, '31_meihua_ai');

    section('5. 紫微斗数（命格 AI 解读 + 追问）');
    await page.click('.p-navitem[data-feature="ziwei"]');
    await page.waitForSelector('#zw-result', { state: 'visible', timeout: 20000 });
    // 命盘异步渲染：等内容足够长再判定，避免过早读到空容器
    await page.waitForFunction(() => (document.getElementById('zw-result') || {}).innerText?.length > 200, null, { timeout: 20000 }).catch(() => {});
    ok('紫微自动排盘', 'len=' + (await page.locator('#zw-result').innerText()).length);
    await shot(page, '20_ziwei_plate');
    // 切到「命格」视图：提问框 #zw-q 只在该视图渲染，等待其出现
    const tabPattern = page.locator('.zw-tabs button[data-v="pattern"]');
    if (await tabPattern.count()) { await tabPattern.click(); }
    await page.waitForSelector('#zw-q', { state: 'visible', timeout: 15000 }).catch(() => {});
    const zwQ = page.locator('#zw-q');
    if (await zwQ.count()) {
      await zwQ.fill('从命格看我的事业方向与性格禀赋');
      await page.click('#zw-ask');
      const zwCard = latestCard(page, '#zw-ai-out');
      try { await waitAI(zwCard); ok('紫微命格 AI 解读', 'len=' + (await zwCard.innerText()).length); }
      catch (e) { fail('紫微命格 AI 解读', e.message.split('\n')[0]); }
      await shot(page, '21_ziwei_ai');
      const zwFollow = zwCard.locator('.ai-follow-btn');
      if (await zwFollow.count()) {
        await zwCard.locator('.ai-follow input').fill('再说说需要注意的短板');
        await zwFollow.click();
        try {
          const zwFollowCard = zwCard.locator('.ai-follow-slot > .p-ai').first();
          await zwFollowCard.waitFor({ state: 'visible', timeout: AI_TIMEOUT });
          await pageWaitForDone(zwFollowCard, AI_TIMEOUT);
          ok('紫微追问');
        } catch (e) { fail('紫微追问', e.message.split('\n')[0]); }
      } else fail('紫微追问', '未出现追问条');
    } else fail('紫微命格视图', '未找到 #zw-q');

    section('6. 塔罗（写问题 + 抽牌 + AI 解读）');
    await page.click('.p-navitem[data-feature="tarot"]');
    await page.waitForSelector('#tr-q', { state: 'visible' });
    await page.fill('#tr-q', '创业还是留在大公司更适合我');
    await page.click('#tr-draw');
    await page.waitForFunction(() => (document.getElementById('tr-result') || {}).innerText?.length > 20, null, { timeout: 15000 });
    ok('塔罗抽牌', 'len=' + (await page.locator('#tr-result').innerText()).length);
    await shot(page, '40_tarot_draw');
    await page.click('#tr-ai');
    const trCard = latestCard(page, '#tr-result');
    try { await waitAI(trCard); ok('塔罗 AI 解读', 'len=' + (await trCard.innerText()).length); }
    catch (e) { fail('塔罗 AI 解读', e.message.split('\n')[0]); }
    // 解读卡应排在牌面结果卡之后（DOM 顺序：.p-result 在 .p-ai 之前）
    const orderOK = await page.evaluate(() => {
      const c = document.getElementById('tr-result');
      if (!c) return false;
      const res = c.querySelector(':scope > .p-result'), ai = c.querySelector(':scope > .p-ai');
      return !!(res && ai && res.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    orderOK ? ok('AI 解读在牌面下方展开') : fail('AI 解读在牌面下方展开');
    const reaskState = await page.evaluate(() => ({
      onPlate: document.querySelectorAll('#tr-result > .p-result .round-reask').length,
      onDoneCard: document.querySelectorAll('#tr-result > .p-ai.done .round-reask').length,
      onStreaming: document.querySelectorAll('#tr-result > .p-ai:not(.done) .round-reask').length
    }));
    (reaskState.onPlate === 0 && reaskState.onDoneCard >= 1 && reaskState.onStreaming === 0)
      ? ok('换问题按钮只在解读完成后出现、不在牌面卡上', JSON.stringify(reaskState))
      : fail('换问题按钮位置', JSON.stringify(reaskState));
    await shot(page, '41_tarot_ai');

    // 新提问语义：问题与牌面绑定 —— 换问题必须重新抽牌 + 旧整轮归档 + 新卡用新问题
    const deck1 = await page.evaluate(() => document.getElementById('tr-result').dataset.deck);
    await page.fill('#tr-q', '换一个全新问题：今年要不要跳槽？');
    await page.click('#tr-ai');
    await page.waitForFunction((d) => (document.getElementById('tr-result') || {}).dataset.deck !== d,
      deck1, { timeout: 15000 }).catch(() => {});
    const deck2 = await page.evaluate(() => document.getElementById('tr-result').dataset.deck);
    (deck1 !== deck2) ? ok('换问题自动重新抽牌', 'deck 已变化') : fail('换问题自动重新抽牌', 'deck 未变化');
    const trNew = latestCard(page, '#tr-result');
    try { await waitAI(trNew); } catch (e) { fail('换问题新解读', e.message.split('\n')[0]); }
    const roundState = await page.evaluate(() => ({
      cards: document.querySelectorAll('#tr-result > .p-ai').length,
      archive: document.querySelectorAll('#p-stage-tarot > .round-archive .round-item').length,
      archivedFollowVisible: [...document.querySelectorAll('#p-stage-tarot > .round-archive .p-ai .ai-follow')]
        .filter(n => getComputedStyle(n).display !== 'none').length,
      head: document.querySelector('#tr-result > .p-ai .p-ai-title')?.textContent || ''
    }));
    (roundState.cards === 1 && roundState.archive === 1 && roundState.archivedFollowVisible === 0)
      ? ok('新提问:旧轮折叠归档+追问条不漏出+当前仅1卡', JSON.stringify(roundState))
      : fail('新提问归档', JSON.stringify(roundState));
    (roundState.head.indexOf('要不要跳槽') >= 0) ? ok('新卡标题用新问题') : fail('新卡标题用新问题', roundState.head);
    await shot(page, '41b_tarot_newround');

    // 归档轮在当前功能内可展开回看 / 再收起（问题绑定整轮，登录态下随时回看）
    const archHead = page.locator('#p-stage-tarot > .round-archive .round-item-hd').first();
    await archHead.click(); await page.waitForTimeout(250);
    const expanded = await page.evaluate(() => {
      const it = document.querySelector('#p-stage-tarot > .round-archive .round-item');
      return { open: it.classList.contains('open'),
        bd: getComputedStyle(it.querySelector('.round-item-bd')).display !== 'none',
        sign: it.querySelector('.rsign').textContent };
    });
    (expanded.open && expanded.bd && expanded.sign === '收起') ? ok('归档轮可展开回看') : fail('归档轮展开', JSON.stringify(expanded));
    await archHead.click(); await page.waitForTimeout(250);
    const collapsed = await page.evaluate(() => {
      const it = document.querySelector('#p-stage-tarot > .round-archive .round-item');
      return { open: it.classList.contains('open'), sign: it.querySelector('.rsign').textContent };
    });
    (!collapsed.open && collapsed.sign === '展开回看') ? ok('归档轮可再收起') : fail('归档轮收起', JSON.stringify(collapsed));

    section('7. 黄历（日历 + AI 择日答疑）');
    await page.click('.p-navitem[data-feature="huangli"]');
    await page.waitForSelector('#hl-day', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(600);
    ok('黄历日历与历注', 'len=' + (await page.locator('#hl-day').innerText()).length);
    await shot(page, '50_huangli');
    await page.fill('#hl-q', '这天适合搬家吗');
    await page.click('#hl-ai');
    const hlCard = latestCard(page, '#hl-result');
    try { await waitAI(hlCard); ok('黄历 AI 答疑', 'len=' + (await hlCard.innerText()).length); }
    catch (e) { fail('黄历 AI 答疑', e.message.split('\n')[0]); }
    await shot(page, '51_huangli_ai');

    section('8. 个人中心（用户名/密码文案 + 历史 + 日期查找）');
    await page.goto(BASE + '/?e2e=' + Date.now() + '#/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await page.waitForSelector('#pf-body', { state: 'visible', timeout: 15000 });
    ok('个人中心加载', '历史卡=' + (await page.locator('.pf-hcard').count()));
    // 删除按钮：应为带边框的「删除」文字按钮，不再是裸 ×
    const delText = await page.locator('.pf-hcard .p-hist-del').first().innerText().catch(() => '');
    (delText.trim() === '删除') ? ok('历史删除按钮为「删除」文字按钮') : fail('历史删除按钮为「删除」文字按钮', JSON.stringify(delText));
    await shot(page, '70_profile');
    const acctToggle = page.locator('.pf-account-toggle');
    if (await acctToggle.count()) {
      await acctToggle.click();
      await page.waitForTimeout(300);
      const acctText = await page.locator('.pf-acct-form').innerText();
      const hasUser = /用户名/.test(acctText), hasPass = /密码/.test(acctText);
      const noNick = !/昵称/.test(acctText), noPasswdWord = !/口令/.test(acctText);
      (hasUser && hasPass && noNick && noPasswdWord)
        ? ok('账号设置文案为「用户名/密码」', '用户名=' + hasUser + ' 密码=' + hasPass + ' 无昵称=' + noNick + ' 无口令=' + noPasswdWord)
        : fail('账号设置文案为「用户名/密码」', acctText.replace(/\n/g, ' ').slice(0, 120));
      await shot(page, '71_profile_account');
    } else fail('账号设置区', '未找到展开按钮');
    // 日期查找：右侧按钮存在，点击弹出与出生日期同款日历
    if (await page.locator('#pf-date-btn').count()) {
      await page.click('#pf-date-btn');
      await page.waitForTimeout(300);
      const calVisible = await page.locator('.dp-modal').isVisible().catch(() => false);
      calVisible ? ok('按日期查找弹日历（同出生日期样式）') : fail('按日期查找弹日历（同出生日期样式）');
      await shot(page, '72_profile_datepicker');
      // 关闭日历弹窗
      const dpX = page.locator('.dp-mask:not(.hidden) .dp-x');
      if (await dpX.count()) await dpX.click();
      else await page.keyboard.press('Escape');
    } else fail('按日期查找按钮存在');
    // 历史卡：纵向滚动容器（max-height + overflow-y auto）
    const hscrollStyle = await page.locator('.pf-hscroll').evaluate(el => ({
      dir: getComputedStyle(el).flexDirection, oy: getComputedStyle(el).overflowY
    })).catch(() => ({}));
    (hscrollStyle.dir === 'column' && hscrollStyle.oy === 'auto')
      ? ok('历史卡上下滚动（纵向）') : fail('历史卡上下滚动（纵向）', JSON.stringify(hscrollStyle));
    // 展开一条历史：追问条应为 AI 解读同款 .ai-follow 结构
    if (await page.locator('.pf-hcard').count()) {
      await page.locator('.pf-hcard').first().click();
      await page.waitForTimeout(500);
      const aiFollowN = await page.locator('[data-hbox] .ai-follow .ai-follow-btn').count();
      aiFollowN ? ok('历史追问条与 AI 解读同款格式') : fail('历史追问条与 AI 解读同款格式');
      // 追问按钮应为描边样式（.tool-ai 同款），不是深色 .p-primary
      const fbtnCls = await page.locator('[data-hbox] .ai-follow-btn').first().getAttribute('class').catch(() => '');
      (!/p-primary/.test(fbtnCls)) ? ok('追问按钮为描边样式（非深色主按钮）') : fail('追问按钮为描边样式（非深色主按钮）', fbtnCls);
      // 备注应位于追问条内部（输入框上方），且不出现「说明：」前缀
      const noteInFollow = await page.locator('[data-hbox] .ai-follow .pf-follow-note').count();
      const noteTxt = await page.locator('[data-hbox] .pf-follow-note').first().innerText().catch(() => '');
      (noteInFollow > 0 && !/说明：/.test(noteTxt))
        ? ok('追问备注在追问条内且无「说明：」前缀', noteTxt.slice(0, 40))
        : fail('追问备注位置/文案', 'inFollow=' + noteInFollow + ' txt=' + noteTxt);
      await shot(page, '73_profile_history_follow');
    }

    section('9. 管理员');
    if (await page.locator('#p-admin-link').count()) ok('管理入口存在');
    else fail('管理入口存在');
    await page.click('#p-admin-link');
    await page.waitForTimeout(300);
    await shot(page, '80_admin_login');
    if (ADMIN_KEY) {
      await page.fill('#admin-key-in', ADMIN_KEY);
      await page.click('#admin-login-btn');
      await page.waitForTimeout(800);
      const userPane = await page.locator('#admin-pane').innerText().catch(() => '');
      /位用户/.test(userPane) ? ok('管理员用户管理', userPane.replace(/\n/g, ' ').slice(0, 80)) : fail('管理员用户管理', userPane.slice(0, 80));
      await shot(page, '81_admin_users');
      const logsTab = page.locator('.ad-tab[data-tab="logs"]');
      if (await logsTab.count()) {
        await logsTab.click();
        await page.waitForTimeout(600);
        ok('管理员运行日志', '条目=' + (await page.locator('.ad-log').count()));
        await shot(page, '82_admin_logs');
      }
      // 看不到对话内容：管理界面文本不应含测试问题关键词
      const adminAll = await page.locator('#p-admin-content').innerText();
      const leaked = /事业格局|新的工作机会|适合搬家|创业还是/.test(adminAll);
      leaked ? fail('管理员看不到对话内容', '疑似泄露问题文本') : ok('管理员看不到对话内容');
    } else {
      info('管理员登录', '未提供 ZIWEI_ADMIN_KEY，仅验证入口与登录表单');
    }

    section('10. 退出登录清除前端缓存');
    // 关闭可能仍打开的管理弹层，避免遮罩挡住后续点击
    await page.evaluate(() => {
      const am = document.getElementById('p-admin-modal');
      if (am && !am.classList.contains('hidden')) am.classList.add('hidden');
      const pm = document.getElementById('p-modal');
      if (pm && !pm.classList.contains('hidden')) pm.classList.add('hidden');
    });
    // 不经整页重载，直接点导航切到塔罗（保留内存里此前各功能舞台的解读卡）
    await page.click('.p-navitem[data-feature="tarot"]');
    await page.waitForTimeout(400);
    const beforeLogout = await page.evaluate(() => ({
      profile: !!localStorage.getItem('zw-profile'),
      cachedAI: document.querySelectorAll('#p-content .p-ai').length
    }));
    // 点右上角「退出」
    await page.click('#p-logout');
    await page.waitForTimeout(600);
    const afterLogout = await page.evaluate(() => ({
      profile: !!localStorage.getItem('zw-profile'),
      aiCards: document.querySelectorAll('#p-content .p-ai').length,
      gate: document.querySelectorAll('.ai-gate .ag-btn').length,
      zwCache: !!sessionStorage.getItem('zw-chart-v1')
    }));
    (beforeLogout.cachedAI > 0 && !afterLogout.profile && !afterLogout.zwCache && afterLogout.gate > 0 && afterLogout.aiCards === 0)
      ? ok('退出清空档案/命盘缓存/对话并恢复门禁', 'beforeAI=' + beforeLogout.cachedAI + ' after=' + JSON.stringify(afterLogout))
      : fail('退出清空缓存', 'before=' + JSON.stringify(beforeLogout) + ' after=' + JSON.stringify(afterLogout));
    await shot(page, '90_after_logout');

    // 跨功能登录：在塔罗登录后，切到八字不应残留"未登录态"的门禁
    await page.click('#p-auth-btn');
    await page.waitForTimeout(200);
    await page.fill('#au-name', USER);
    await page.fill('#au-pass', PASS);
    await page.click('#au-submit');
    await page.waitForTimeout(1200);
    await page.click('.p-navitem[data-feature="bazi"]');
    await page.waitForTimeout(600);
    const crossGate = await page.evaluate(() => ({
      prof: !!localStorage.getItem('zw-profile'),
      gate: document.querySelectorAll('#p-stage-bazi .ai-gate').length,
      locked: document.querySelectorAll('#p-stage-bazi.stage-locked').length
    }));
    (crossGate.prof && crossGate.gate === 0 && crossGate.locked === 0)
      ? ok('跨功能登录后门禁不残留')
      : fail('跨功能登录后门禁不残留', JSON.stringify(crossGate));
    await shot(page, '91_relogin_cross_feature');

    section('11. 页面错误检查');
    pageErrors.length ? fail('无前端 JS 报错', pageErrors.slice(0, 3).join(' | ')) : ok('无前端 JS 报错');
  } catch (e) {
    fail('测试流程中断', e.message.split('\n')[0]);
    await shot(page, '99_aborted').catch(() => {});
  } finally {
    section('汇总');
    const pass = results.filter(r => r.status === 'PASS').length;
    const fl = results.filter(r => r.status === 'FAIL').length;
    console.log('PASS=' + pass + '  FAIL=' + fl + '  INFO=' + results.filter(r => r.status === 'INFO').length);
    const report = { runId: RUN_ID, base: BASE, user: USER, screenshots: fs.readdirSync(SHOT_DIR).filter(f => f.startsWith(RUN_ID)), results };
    fs.writeFileSync(path.join(SHOT_DIR, RUN_ID + '_report.json'), JSON.stringify(report, null, 2));
    console.log('REPORT=' + path.join(SHOT_DIR, RUN_ID + '_report.json'));

    // 清理临时账号（仅当提供管理员口令）
    if (ADMIN_KEY) {
      try {
        const r = await fetch(BASE + '/api/admin/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
          body: JSON.stringify({ name: USER })
        });
        const d = await r.json();
        d.ok ? ok('清理临时账号', USER) : fail('清理临时账号', JSON.stringify(d));
      } catch (e) { fail('清理临时账号', e.message); }
    }
    await browser.close();
    process.exit(results.some(r => r.status === 'FAIL') ? 1 : 0);
  }
})();
