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
  console.log('🚀 启动企业合同与采购项目台账系统全链路冒烟测试 (v2.5.4 文件夹超链接与命名规范版)...');
  const { port, shutdown } = await startServer(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode = 0;

  try {
    // 0. 验证内网状态 API 动态端口一致性
    const lanStatus = await fetch(`${baseUrl}/api/lan-auth/status`).then(r => r.json());
    assert.strictEqual(lanStatus.port, port, `内网协同状态返回的端口(${lanStatus.port})必须与实际监听端口(${port})一致`);
    console.log('✅ [通过] 内网协同状态动态端口实时同步验证成功:', lanStatus.port);

    // 1. 验证采购立项分段编号生成
    const pNoRes = await fetch(`${baseUrl}/api/procurements/next-no?approval_date=2026-03-18&mid_custom=-ABC-`).then(r => r.json());
    assert.strictEqual(pNoRes.success, true);
    assert.strictEqual(pNoRes.next_no, 'LX-ABC-20260318001');
    console.log('✅ [通过] 采购立项夹心式分段编号验证成功:', pNoRes.next_no);

    // 2. 录入采购立项（含 2 份立项资料文件）
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

    // 3. 录入关联合同（含主合同扫描件 + 2 份其他相关资料）
    const cForm = new FormData();
    cForm.append('contract_no', 'HT-ABC-202603003');
    cForm.append('contract_name', 'ABC公司年度物流配送服务合同');
    cForm.append('contract_type', '服务');
    cForm.append('status', '生效中');
    cForm.append('our_entity', 'ABC公司');
    cForm.append('sign_date', '2026.3.20');
    cForm.append('start_date', '2026.3.20');
    cForm.append('expiry_date', '2027-03-19');
    cForm.append('procurement_id', String(procId));
    cForm.append('remark', '主表合同层公共备注');
    cForm.append('counterparties_json', JSON.stringify([{
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
    cForm.append('attachment', new Blob(['%PDF-1.4 dummy scan'], { type: 'application/pdf' }), 'scan.pdf');
    cForm.append('related_files', new Blob(['补充协议1'], { type: 'text/plain' }), '补充协议.txt');
    cForm.append('related_files', new Blob(['报价明细2'], { type: 'text/plain' }), '报价明细.txt');

    const cCreateRes = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm }).then(r => r.json());
    assert.strictEqual(cCreateRes.success, true);
    const contractId = cCreateRes.id;

    // 4. 校验文件与文件夹命名规范
    const cDetail = (await fetch(`${baseUrl}/api/contracts/${contractId}`).then(r => r.json())).data;
    const pDetail = (await fetch(`${baseUrl}/api/procurements/${procId}`).then(r => r.json())).data;

    assert.strictEqual(
      cDetail.attachment_path,
      '2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf',
      `主合同扫描件命名不符合预期: ${cDetail.attachment_path}`
    );
    assert.ok(
      cDetail.related_files[0].file_path.includes('2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件/'),
      `合同其他资料文件夹命名不符合预期: ${cDetail.related_files[0].file_path}`
    );
    assert.ok(
      pDetail.files[0].file_path.includes('2026-001_LX20260318002_ABC公司年度物流配送服务采购项目_立项资料/'),
      `采购立项资料文件夹命名不符合预期: ${pDetail.files[0].file_path}`
    );
    console.log('✅ [通过] 扫描件命名【序号_编号_合同名称】及双资料夹后缀【_其他合同附件 / _立项资料】验证成功');

    // 5. 验证导出 Excel 超链接：主合同扫描件链向文件，其他资料与立项资料链向对应文件夹
    const expCombined = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expCombined.status, 200);
    const combBuf = Buffer.from(await expCombined.arrayBuffer());
    const combWb = XLSX.read(combBuf, { type: 'buffer', cellFormula: true });

    const wsContract = combWb.Sheets['合同台账'];
    const wsProc = combWb.Sheets['采购项目台账'];

    // AE3 (第30列): 主合同扫描件超链接指向具体文件
    assert.ok(
      wsContract['AE3'].f.includes('HYPERLINK("uploads/2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf"'),
      `合同表主扫描件超链接异常: ${wsContract['AE3'].f}`
    );
    // AF3 (第31列): 关联采购立项号超链接指向 _立项资料 文件夹
    assert.ok(
      wsContract['AF3'].f.includes('HYPERLINK("uploads/procurement/2026-001_LX20260318002_ABC公司年度物流配送服务采购项目_立项资料"'),
      `合同表关联采购立项文件夹超链接异常: ${wsContract['AF3'].f}`
    );
    // AG3 (第32列): 其他相关资料超链接指向 _其他合同附件 文件夹
    assert.ok(
      wsContract['AG3'].f.includes('HYPERLINK("uploads/related/2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件"'),
      `合同表其他相关资料文件夹超链接异常: ${wsContract['AG3'].f}`
    );

    // 采购表 P3 (第15列): 关联合同编号指向主合同扫描件文件
    assert.ok(
      wsProc['P3'].f.includes('HYPERLINK("uploads/2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf","HT-ABC-202603003")'),
      `采购表关联合同编号超链接异常: ${wsProc['P3'].f}`
    );
    // 采购表 R3 (第17列): 立项相关资料指向 _立项资料 文件夹
    assert.ok(
      wsProc['R3'].f.includes('HYPERLINK("uploads/procurement/2026-001_LX20260318002_ABC公司年度物流配送服务采购项目_立项资料"'),
      `采购表立项相关资料文件夹超链接异常: ${wsProc['R3'].f}`
    );
    console.log('✅ [通过] Excel 导出超链接（扫描件链向文件、多份资料链向对应文件夹）验证成功');

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
