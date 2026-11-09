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
  console.log('🚀 启动企业合同与采购项目台账系统全链路冒烟测试 (v2.5.5 序号手动调序与文件夹超链接版)...');
  const { port, shutdown } = await startServer(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode = 0;

  try {
    // 0. 验证内网状态 API 动态端口一致性
    const lanStatus = await fetch(`${baseUrl}/api/lan-auth/status`).then(r => r.json());
    assert.strictEqual(lanStatus.port, port, `内网协同状态返回的端口(${lanStatus.port})必须与实际监听端口(${port})一致`);
    console.log('✅ [通过] 内网协同状态动态端口实时同步验证成功:', lanStatus.port);

    // 1. 录入采购立项（含 2 份立项资料文件）
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
    pForm.append('has_contract', '否');
    pForm.append('remark', '采购立项定稿备注说明');
    pForm.append('procurement_files', new Blob(['立项批复文件1'], { type: 'text/plain' }), '立项批复单.txt');
    pForm.append('procurement_files', new Blob(['评审纪要文件2'], { type: 'text/plain' }), '评审纪要.txt');

    const pCreateRes = await fetch(`${baseUrl}/api/procurements`, { method: 'POST', body: pForm }).then(r => r.json());
    assert.strictEqual(pCreateRes.success, true);
    const procId = pCreateRes.id;

    // 2. 录入第 1 条合同（签订日期较早：2026-03-20，初始序号 2026-001）
    const cForm1 = new FormData();
    cForm1.append('contract_no', 'HT-ABC-202603003');
    cForm1.append('contract_name', 'ABC公司年度物流配送服务合同');
    cForm1.append('contract_type', '服务');
    cForm1.append('status', '生效中');
    cForm1.append('our_entity', 'ABC公司');
    cForm1.append('sign_date', '2026.3.20');
    cForm1.append('start_date', '2026.3.20');
    cForm1.append('expiry_date', '2027-03-19');
    cForm1.append('procurement_id', String(procId));
    cForm1.append('remark', '主表合同层公共备注');
    cForm1.append('counterparties_json', JSON.stringify([{
      company_name: 'BCD公司',
      credit_code: '91522400MA6XXXXXXX',
      summary: '第一季度完成华东干线调度',
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
    cForm1.append('attachment', new Blob(['%PDF-1.4 dummy scan 1'], { type: 'application/pdf' }), 'scan1.pdf');
    cForm1.append('related_files', new Blob(['补充协议1'], { type: 'text/plain' }), '补充协议.txt');

    const cCreateRes1 = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm1 }).then(r => r.json());
    assert.strictEqual(cCreateRes1.success, true);
    const contractId1 = cCreateRes1.id;

    // 3. 录入第 2 条合同（签订日期较晚：2026-05-10，初始序号 2026-002）
    const cForm2 = new FormData();
    cForm2.append('contract_no', 'HT-ABC-202605009');
    cForm2.append('contract_name', 'GHI公司设备维保技术服务合同');
    cForm2.append('contract_type', '服务');
    cForm2.append('status', '生效中');
    cForm2.append('our_entity', 'ABC公司');
    cForm2.append('sign_date', '2026-05-10');
    cForm2.append('start_date', '2026-05-10');
    cForm2.append('expiry_date', '2027-05-09');
    cForm2.append('counterparties_json', JSON.stringify([{
      company_name: 'GHI公司',
      amount: 120000,
      tax_rate: '6%'
    }]));
    cForm2.append('attachment', new Blob(['%PDF-1.4 dummy scan 2'], { type: 'application/pdf' }), 'scan2.pdf');

    const cCreateRes2 = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm2 }).then(r => r.json());
    assert.strictEqual(cCreateRes2.success, true);
    const contractId2 = cCreateRes2.id;

    // 4. 验证点击序号手动调序：将原本排第 2 的 contractId2 (2026-002) 调整到序号 1 (2026-001)
    const reorderRes = await fetch(`${baseUrl}/api/contracts/${contractId2}/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_seq: '1' })
    }).then(r => r.json());
    assert.strictEqual(reorderRes.success, true);
    assert.strictEqual(reorderRes.seq_no, '2026-001');

    // 验证调序后：contractId2 变成 2026-001，contractId1 自动顺延为 2026-002，且双方磁盘文件名/文件夹名同步更新
    const cDetail1 = (await fetch(`${baseUrl}/api/contracts/${contractId1}`).then(r => r.json())).data;
    const cDetail2 = (await fetch(`${baseUrl}/api/contracts/${contractId2}`).then(r => r.json())).data;

    assert.strictEqual(cDetail2.seq_no, '2026-001', 'contractId2 应插队变为 2026-001');
    assert.strictEqual(
      cDetail2.attachment_path,
      '2026-001_HT-ABC-202605009_GHI公司设备维保技术服务合同.pdf',
      '插队到 001 的合同扫描件文件名应同步变更为 2026-001_...'
    );

    assert.strictEqual(cDetail1.seq_no, '2026-002', 'contractId1 应顺延变为 2026-002');
    assert.strictEqual(
      cDetail1.attachment_path,
      '2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf',
      '顺延到 002 的合同扫描件文件名应同步变更为 2026-002_...'
    );
    assert.ok(
      cDetail1.related_files[0].file_path.includes('2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件/'),
      `顺延到 002 的合同其他资料文件夹应同步变更为 2026-002_...: ${cDetail1.related_files[0].file_path}`
    );
    console.log('✅ [通过] 选项 B 点击序号手动调序、插队顺延及磁盘扫描件/文件夹名自动重命名验证成功');

    // 5. 验证导出 Excel 超链接与新序号保持一致
    const expCombined = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expCombined.status, 200);
    const combBuf = Buffer.from(await expCombined.arrayBuffer());
    const combWb = XLSX.read(combBuf, { type: 'buffer', cellFormula: true });
    const wsContract = combWb.Sheets['合同台账'];

    // 第 3 行是 2026-001 (contractId2)，第 4 行是 2026-002 (contractId1)
    assert.strictEqual(wsContract['A3'].v, '2026-001');
    assert.strictEqual(wsContract['A4'].v, '2026-002');
    assert.ok(
      wsContract['AG4'].f.includes('HYPERLINK("uploads/related/2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件"'),
      `顺延后导出 Excel 的文件夹超链接应同步为最新路径: ${wsContract['AG4'].f}`
    );
    console.log('✅ [通过] 调序后导出 Excel 文件夹超链接同步验证成功');

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
