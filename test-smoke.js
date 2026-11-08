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
  console.log('🚀 启动企业合同与采购项目台账系统全链路冒烟测试 (v2.5.0 修正增强版)...');
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

    // 3. 录入采购立项
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

    // 4. 录入关联合同
    const cForm = new FormData();
    cForm.append('contract_no', 'HT-ABC-202603003');
    cForm.append('contract_name', 'ABC公司年度物流配送服务合同');
    cForm.append('contract_type', '服务');
    cForm.append('status', '履行中');
    cForm.append('our_entity', 'ABC公司');
    cForm.append('sign_date', '2026.3.20');
    cForm.append('start_date', '2026.3.20');
    cForm.append('expiry_date', '2020-01-01');
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

    // 5. 校验文件夹命名规范：序号_编号_名称（彻底杜绝 PROC_1 / CONTRACT_1）
    const cDetail = (await fetch(`${baseUrl}/api/contracts/${contractId}`).then(r => r.json())).data;
    const pDetail = (await fetch(`${baseUrl}/api/procurements/${procId}`).then(r => r.json())).data;

    assert.ok(
      cDetail.related_files[0].file_path.includes('2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同/'),
      `合同资料文件夹命名不符合预期: ${cDetail.related_files[0].file_path}`
    );
    assert.ok(
      pDetail.files[0].file_path.includes('2026-001_LX20260318002_ABC公司年度物流配送服务采购项目/'),
      `采购立项资料文件夹命名不符合预期: ${pDetail.files[0].file_path}`
    );
    console.log('✅ [通过] 磁盘文件夹自动命名为【序号_编号_名称】验证成功');

    // 6. 验证单独导出合同 Excel、单独导出采购 Excel 与合并导出均返回 200 (修复 /api/procurements/export 报错)
    const expSingleContract = await fetch(`${baseUrl}/api/export/excel?mode=all`);
    assert.strictEqual(expSingleContract.status, 200, '单独导出合同台账必须返回 200');

    const expSingleProc = await fetch(`${baseUrl}/api/procurements/export?mode=all`);
    assert.strictEqual(expSingleProc.status, 200, '单独导出采购立项台账必须返回 200');

    const expCombined = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expCombined.status, 200, '合并导出双台账总表必须返回 200');

    const buf = Buffer.from(await expCombined.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });
    const wsContract = wb.Sheets['合同台账'];
    const wsProc = wb.Sheets['采购项目台账'];

    // 验证表头去掉了“采购立项资料(点击打开)”列及所有“(点击打开)”字样
    assert.strictEqual(wsContract['AE2'].v, '主合同扫描件');
    assert.strictEqual(wsContract['AF2'].v, '关联采购立项号');
    assert.strictEqual(wsContract['AG2'].v, '其他相关资料');
    assert.strictEqual(wsContract['AH2'].v, '本合同含税总额(元)');

    // 验证主合同扫描件直接显示文件名，关联采购立项号直接带超链接且显示立项号
    assert.strictEqual(wsContract['AE3'].v, 'HT-ABC-202603003.pdf');
    assert.ok(wsContract['AE3'].f.includes('HYPERLINK'), '主合同扫描件必须包含超链接');
    assert.strictEqual(wsContract['AF3'].v, 'LX20260318002');
    assert.ok(wsContract['AF3'].f.includes('HYPERLINK'), '关联采购立项号在有资料时必须直接包含超链接');

    assert.strictEqual(wsProc['R2'].v, '立项相关资料');
    console.log('✅ [通过] 单独导出与合并导出、超链接改造、无填充表头验证全部成功');

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
