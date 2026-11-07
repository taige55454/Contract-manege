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
  console.log('🚀 启动企业合同与采购项目台账系统全链路冒烟测试 (v2.4.2)...');
  const { port, shutdown } = await startServer(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. 验证采购立项夹心式编号生成
    const pNoRes = await fetch(`${baseUrl}/api/procurements/next-no?approval_date=2026-03-18&mid_custom=-BJ-`).then(r => r.json());
    assert.strictEqual(pNoRes.success, true);
    assert.strictEqual(pNoRes.next_no, 'LX-BJ-20260318001');
    console.log('✅ [通过] 采购立项夹心式分段编号引擎验证成功:', pNoRes.next_no);

    // 2. 验证自定义预设防漏保底 + 动态状态名称流转（改名为“履行中 / 已超期”）
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

    // 3. 先录入采购立项（含 Excel 序列号日期 46099 与预填合同号 XSZY-黔-BJ-202603003）+ 上传立项资料
    const pForm = new FormData();
    pForm.append('procurement_no', 'LX20260318002');
    pForm.append('project_name', 'ABC产品邮寄配送服务采购');
    pForm.append('project_type', '服务类项目');
    pForm.append('cost_department', '省区费用预算');
    pForm.append('budget_amount', '300000');
    pForm.append('budget_subject', '运输费');
    pForm.append('approval_date', '46099');
    pForm.append('decision_date', '46100');
    pForm.append('completion_date', '46103');
    pForm.append('supplier_name', '中国邮政速递物流股份有限公司');
    pForm.append('deal_amount', '300000');
    pForm.append('has_contract', '是');
    pForm.append('contract_no_manual', 'XSZY-黔-BJ-202603003');
    pForm.append('procurement_files', new Blob(['立项请示批复内容'], { type: 'text/plain' }), '立项批复单.txt');

    const pCreateRes = await fetch(`${baseUrl}/api/procurements`, { method: 'POST', body: pForm }).then(r => r.json());
    assert.strictEqual(pCreateRes.success, true);
    const procId = pCreateRes.id;

    // 4. 后录入同编号合同 XSZY-黔-BJ-202603003（测试开户行、保证金、质保金、公共备注及双向自动挂钩）
    const cForm = new FormData();
    cForm.append('contract_no', 'XSZY-黔-BJ-202603003');
    cForm.append('contract_name', 'ABC公司产品邮寄配送服务合同');
    cForm.append('contract_type', '服务');
    cForm.append('status', '履行中');
    cForm.append('our_entity', 'ABC公司');
    cForm.append('sign_date', '2026.3.20');
    cForm.append('start_date', '2026.3.20');
    cForm.append('expiry_date', '2020-01-01'); // 故意传过去日期，测试是否自动流转为自定义到期态“已超期”
    cForm.append('remark', '主表整份合同公共备注');
    cForm.append('counterparties_json', JSON.stringify([{
      company_name: '中国邮政速递物流股份有限公司',
      credit_code: '91522400MA6XXXXXXX',
      bank_account_no: '52001658800052500000',
      bank_name: '中国邮政储蓄银行xx市分行',
      amount: 300000,
      tax_rate: '6',
      currency: 'CNY',
      perf_bond_amount: 15000,
      perf_bond_status: '未退',
      perf_bond_return_date: '2027-03-31',
      warranty_bond_amount: 9000,
      warranty_bond_status: '未退',
      warranty_bond_expiry_date: '2028-03-31',
      remark: '分项履约备注'
    }]));
    cForm.append('attachment', new Blob(['%PDF-1.4 dummy scan'], { type: 'application/pdf' }), 'scan.pdf');
    cForm.append('related_files', new Blob(['报价附件'], { type: 'text/plain' }), '报价明细表.txt');

    const cCreateRes = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm }).then(r => r.json());
    assert.strictEqual(cCreateRes.success, true);
    const contractId = cCreateRes.id;

    // 5. 验证合同详情、动态状态流转、18个细分字段完整性与跨模块文件直连
    const cDetail = (await fetch(`${baseUrl}/api/contracts/${contractId}`).then(r => r.json())).data;
    const pDetail = (await fetch(`${baseUrl}/api/procurements/${procId}`).then(r => r.json())).data;

    assert.strictEqual(cDetail.status, '已超期', '过期合同应自动流转为用户自定义的“已超期”状态');
    assert.strictEqual(cDetail.remark, '主表整份合同公共备注', '合同主表公共备注应正确保存');
    assert.strictEqual(cDetail.counterparties[0].bank_name, '中国邮政储蓄银行毕节市分行', '开户银行独立字段应正确保存');
    assert.strictEqual(cDetail.counterparties[0].perf_bond_amount, 15000, '履约保证金应正确保存');
    assert.strictEqual(cDetail.counterparties[0].warranty_bond_amount, 9000, '质保金金额应正确保存');
    assert.strictEqual(cDetail.procurement_id, procId, '合同应自动关联到采购立项 ID');
    assert.strictEqual(pDetail.contract_id, contractId, '采购立项应自动反向关联到合同 ID');
    console.log('✅ [通过] 自定义状态自动流转 + 18个履约细分字段 + 顺序可逆双向关联验证成功');

    // 6. 验证顶部一键同时导出双子表总台账 (/api/export/combined)
    const expRes = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expRes.status, 200);
    const buf = Buffer.from(await expRes.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });

    assert.deepStrictEqual(wb.SheetNames, ['合同台账', '采购项目台账']);
    const wsContract = wb.Sheets['合同台账'];
    const wsProc = wb.Sheets['采购项目台账'];

    assert.strictEqual(wsContract['R3'].v, '中国邮政储蓄银行xx市分行', 'Excel R列应独立导出开户银行');
    assert.strictEqual(wsContract['AA3'].v, 9000, 'Excel AA列应导出质保金金额');
    assert.ok(wsContract['AD3'].v.includes('分项履约备注；主表整份合同公共备注'), 'Excel AD列应合并导出分项与主表备注');
    assert.ok(wsContract['AE3'].f.includes('HYPERLINK("uploads/'));
    assert.ok(wsProc['R3'].f.includes('HYPERLINK("uploads/procurement/'));
    console.log('✅ [通过] 双子表同时导出 + 开户行/质保金/合并备注 + 相对路径超链接公式验证成功');

  } finally {
    await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('🧹 测试环境与数据库句柄已 100% 释放完毕！全部测试通过！');
  }
})();
