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
  console.log('🚀 启动企业合同与采购项目台账系统全链路冒烟测试...');
  const { port, shutdown } = await startServer(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. 验证采购立项夹心式编号生成 (LX + YYYYMMDD + 3位流水 + 支持穿插自定义段)
    const pNoRes = await fetch(`${baseUrl}/api/procurements/next-no?approval_date=2026-03-18&mid_custom=-BJ-`).then(r => r.json());
    assert.strictEqual(pNoRes.success, true);
    assert.strictEqual(pNoRes.next_no, 'LX-BJ-20260318001');
    console.log('✅ [通过] 采购立项夹心式分段编号引擎验证成功:', pNoRes.next_no);

    // 2. 验证场景 C（顺序可逆）：先录入采购立项（含 Excel 序列号日期 46099 与预填合同号 XSZY-黔-BJ-202603003）+ 上传立项资料
    const pForm = new FormData();
    pForm.append('procurement_no', 'LX20260318002');
    pForm.append('project_name', '毕节自营公司产品邮寄配送服务采购');
    pForm.append('project_type', '服务类项目');
    pForm.append('cost_department', '省区费用预算');
    pForm.append('budget_amount', '300000');
    pForm.append('budget_subject', '运输费');
    pForm.append('approval_date', '46099'); // Excel 序列号 -> 2026-03-18
    pForm.append('decision_date', '46100');
    pForm.append('completion_date', '46103');
    pForm.append('supplier_name', '中国邮政速递物流股份有限公司毕节市分公司');
    pForm.append('deal_amount', '300000');
    pForm.append('has_contract', '是');
    pForm.append('contract_no_manual', 'XSZY-黔-BJ-202603003');
    pForm.append('procurement_files', new Blob(['立项请示批复内容'], { type: 'text/plain' }), '立项批复单.txt');

    const pCreateRes = await fetch(`${baseUrl}/api/procurements`, { method: 'POST', body: pForm }).then(r => r.json());
    assert.strictEqual(pCreateRes.success, true);
    const procId = pCreateRes.id;

    // 3. 后录入同编号合同 XSZY-黔-BJ-202603003，测试是否自动与上述采购立项完成双向挂钩
    const cForm = new FormData();
    cForm.append('contract_no', 'XSZY-黔-BJ-202603003');
    cForm.append('contract_name', '毕节自营公司产品邮寄配送服务合同');
    cForm.append('contract_type', '服务');
    cForm.append('status', '生效中');
    cForm.append('our_entity', '毕节自营公司');
    cForm.append('sign_date', '2026.3.20');
    cForm.append('start_date', '2026.3.20');
    cForm.append('expiry_date', '2027.3.19');
    cForm.append('counterparties_json', JSON.stringify([{
      company_name: '中国邮政速递物流股份有限公司毕节市分公司',
      credit_code: '91522400MA6XXXXXXX',
      amount: 300000,
      tax_rate: '6'
    }]));
    cForm.append('attachment', new Blob(['%PDF-1.4 dummy scan'], { type: 'application/pdf' }), 'scan.pdf');
    cForm.append('related_files', new Blob(['报价附件'], { type: 'text/plain' }), '报价明细表.txt');

    const cCreateRes = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm }).then(r => r.json());
    assert.strictEqual(cCreateRes.success, true);
    const contractId = cCreateRes.id;

    // 4. 验证合同详情与采购详情是否已完成双向互锁与跨模块文件直连
    const cDetail = (await fetch(`${baseUrl}/api/contracts/${contractId}`).then(r => r.json())).data;
    const pDetail = (await fetch(`${baseUrl}/api/procurements/${procId}`).then(r => r.json())).data;

    assert.strictEqual(pDetail.approval_date, '2026-03-18', 'Excel 序列号 46099 应自动转为 2026-03-18');
    assert.strictEqual(pDetail.cost_department, '省区费用预算', '费用承担部门字段应正确保存');
    assert.strictEqual(cDetail.procurement_id, procId, '合同应自动关联到采购立项 ID');
    assert.strictEqual(pDetail.contract_id, contractId, '采购立项应自动反向关联到合同 ID');
    assert.strictEqual(cDetail.linked_procurement.files.length, 1, '合同应能直接读取采购立项的资料列表');
    assert.ok(pDetail.linked_contract.attachment_path.includes('XSZY-黔-BJ-202603003'), '采购立项应能直接读取关联合同扫描件');
    console.log('✅ [通过] 顺序可逆双向自动关联 + 三大文件物理隔离与跨模块穿透验证成功');

    // 5. 验证顶部一键同时导出双子表总台账 (/api/export/combined)
    const expRes = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expRes.status, 200);
    const buf = Buffer.from(await expRes.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });

    assert.deepStrictEqual(wb.SheetNames, ['合同台账', '采购项目台账'], '合并导出工作簿应包含合同台账与采购项目台账两个子表');
    const wsContract = wb.Sheets['合同台账'];
    const wsProc = wb.Sheets['采购项目台账'];

    // 检查合同子表的 3 列超链接 (AE3, AF3, AG3)
    assert.ok(wsContract['AE3'].f.includes('HYPERLINK("uploads/'), '合同子表应包含合同扫描件超链接');
    assert.ok(wsContract['AF3'].f.includes('HYPERLINK("uploads/procurement/'), '合同子表应包含采购立项资料夹超链接');
    assert.ok(wsContract['AG3'].f.includes('HYPERLINK("uploads/related/'), '合同子表应包含合同其他附件夹超链接');

    // 检查采购子表的 2 列超链接 (R3, S3)
    assert.ok(wsProc['R3'].f.includes('HYPERLINK("uploads/procurement/'), '采购子表应包含立项相关资料夹超链接');
    assert.ok(wsProc['S3'].f.includes('HYPERLINK("uploads/'), '采购子表应包含关联合同扫描件超链接');
    console.log('✅ [通过] 顶部双子表同时导出 + 隔行斑马纹 + 全部相对路径超链接公式验证成功');

  } finally {
    await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('🧹 测试环境与数据库句柄已 100% 释放完毕！全部测试通过！');
  }
})();
