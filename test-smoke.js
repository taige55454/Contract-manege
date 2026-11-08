const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx-js-style');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-proc-smoke-'));
process.env.DATA_ROOT = tempDir;
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');

const { startServer } = require('./server');

(async () => {
  console.log('🚀 启动企业合同与采购项目台账系统全链路冒烟测试 (脱敏及年份序号定稿版)...');
  const { port, shutdown } = await startServer(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode = 0;

  try {
    // 1. 验证采购立项分段编号生成
    const pNoRes = await fetch(`${baseUrl}/api/procurements/next-no?approval_date=2026-03-18&mid_custom=-ABC-`).then(r => r.json());
    assert.strictEqual(pNoRes.success, true);
    assert.strictEqual(pNoRes.next_no, 'LX-ABC-20260318001');
    console.log('✅ [通过] 采购立项夹心式分段编号验证成功:', pNoRes.next_no);

    // 2. 验证自定义预设与动态到期态
    const presetRes = await fetch(`${baseUrl}/api/settings/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presets: {
          contract_statuses: '草稿、履行中、已超期、已终止'
        }
      })
    }).then(r => r.json());
    assert.strictEqual(presetRes.success, true);
    assert.ok(presetRes.presets.contract_statuses.includes('履行中'));
    assert.ok(presetRes.presets.contract_statuses.includes('已超期'));

    // 3. 录入采购立项（脱敏数据：ABC公司、BCD公司，Excel 序列号日期 46099）
    const pForm = new FormData();
    pForm.append('procurement_no', 'LX20260318002');
    pForm.append('project_name', 'ABC公司年度物流配送服务采购项目');
    pForm.append('project_type', '服务类项目');
    pForm.append('cost_department', '运营管理部');
    pForm.append('budget_amount', '300000');
    pForm.append('budget_subject', '运输费');
    pForm.append('approval_date', '46099');
    pForm.append('decision_date', '46100');
    pForm.append('completion_date', '46103');
    pForm.append('supplier_name', 'BCD公司');
    pForm.append('deal_amount', '300000');
    pForm.append('has_contract', '是');
    pForm.append('contract_no_manual', 'HT-ABC-202603003');
    pForm.append('remark', '采购立项定稿备注说明');
    pForm.append('procurement_files', new Blob(['立项批复文件正文内容'], { type: 'text/plain' }), '立项批复单.txt');

    const pCreateRes = await fetch(`${baseUrl}/api/procurements`, { method: 'POST', body: pForm }).then(r => r.json());
    assert.strictEqual(pCreateRes.success, true);
    const procId = pCreateRes.id;

    // 4. 录入关联合同（履约摘要多行文本、银行四要素、多税率 6，9、分项备注）
    const cForm = new FormData();
    cForm.append('contract_no', 'HT-ABC-202603003');
    cForm.append('contract_name', 'ABC公司年度物流配送服务合同');
    cForm.append('contract_type', '服务');
    cForm.append('status', '履行中');
    cForm.append('our_entity', 'ABC公司');
    cForm.append('sign_date', '2026.3.20');
    cForm.append('start_date', '2026.3.20');
    cForm.append('expiry_date', '2020-01-01'); // 过去日期触发自动判断
    cForm.append('remark', '主表合同层公共备注');
    cForm.append('counterparties_json', JSON.stringify([{
      company_name: 'BCD公司',
      credit_code: '91522400MA6XXXXXXX',
      summary: '第一季度完成华东干线调度\n第二季度完成华南仓储承运与交付',
      contact_person: '张经理',
      contact_phone: '13800138000',
      bank_account_name: 'BCD公司',
      bank_account_no: '52001658800052500000',
      bank_name: 'DEF银行营业部',
      bank_code: '102100000018',
      amount: 300000,
      amount_excl_tax: 280000,
      tax_rate: '6，9',
      currency: 'CNY',
      perf_bond_amount: 15000,
      perf_bond_status: '未退',
      perf_bond_return_date: '2027-03-31',
      warranty_bond_amount: 9000,
      warranty_bond_status: '未退',
      warranty_bond_expiry_date: '2028-03-31',
      remark: '对方单位分项备注'
    }]));
    cForm.append('attachment', new Blob(['%PDF-1.4 dummy scan'], { type: 'application/pdf' }), 'scan.pdf');
    cForm.append('related_files', new Blob(['补充协议附件'], { type: 'text/plain' }), '补充协议.txt');

    const cCreateRes = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm }).then(r => r.json());
    assert.strictEqual(cCreateRes.success, true);
    const contractId = cCreateRes.id;

    // 5. 校验年份序号 YYYY-001 与数据字段
    const cDetail = (await fetch(`${baseUrl}/api/contracts/${contractId}`).then(r => r.json())).data;
    const pDetail = (await fetch(`${baseUrl}/api/procurements/${procId}`).then(r => r.json())).data;

    assert.strictEqual(cDetail.seq_no, '2026-001', '合同台账序号必须为 YYYY-001 格式');
    assert.strictEqual(pDetail.seq_no, '2026-001', '采购立项台账第一列序号必须统一为 YYYY-001 格式');
    assert.strictEqual(cDetail.status, '已超期', '到期日期小于今日应自动变为“已超期”');
    assert.strictEqual(cDetail.counterparties[0].bank_code, '102100000018', '开户行号必须独立完整保存');
    assert.strictEqual(cDetail.counterparties[0].tax_rate, '*6%、9%', '多税率 6，9 必须自动格式化为 *6%、9%');
    assert.ok(cDetail.counterparties[0].summary.includes('第一季度'), '履约摘要应完整保存换行内容');
    assert.strictEqual(cDetail.procurement_id, procId, '双向穿透：合同关联采购 ID 验证成功');
    assert.strictEqual(pDetail.contract_id, contractId, '双向穿透：采购关联合同 ID 验证成功');
    console.log('✅ [通过] 年份序号 2026-001 + 履约摘要/备注独立换行 + 银行四要素 + 多税率验证成功');

    // 6. 验证双台账一键合并导出 Excel 表头与样式
    const expRes = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expRes.status, 200);
    const buf = Buffer.from(await expRes.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });

    assert.deepStrictEqual(wb.SheetNames, ['合同台账', '采购项目台账']);
    const wsContract = wb.Sheets['合同台账'];
    const wsProc = wb.Sheets['采购项目台账'];

    // 验证表头无括号冗余，规范为“履约摘要”与“备注”
    assert.strictEqual(wsContract['A2'].v, '序号');
    assert.strictEqual(wsContract['A3'].v, '2026-001');
    assert.strictEqual(wsContract['J2'].v, '履约摘要');
    assert.strictEqual(wsContract['R2'].v, '开户行号');
    assert.strictEqual(wsContract['R3'].v, '102100000018');
    assert.strictEqual(wsContract['U3'].v, '*6%、9%');
    assert.strictEqual(wsContract['AD2'].v, '备注');
    assert.ok(wsContract['AD3'].v.includes('对方单位分项备注\n主表合同层公共备注'));

    // 验证采购台账第一列同样为 2026-001
    assert.strictEqual(wsProc['A2'].v, '序号');
    assert.strictEqual(wsProc['A3'].v, '2026-001');
    console.log('✅ [通过] Excel 导出表头规范化（履约摘要/备注）与全闭合边框/年份序号验证成功');

  } catch (err) {
    console.error('❌ 测试未通过:', err);
    exitCode = 1;
  } finally {
    await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('🧹 临时测试资源已释放完毕！');
    process.exit(exitCode);
  }
})();
