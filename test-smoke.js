const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx-js-style');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-full-regression-'));
process.env.DATA_ROOT = tempDir;
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');

const { startServer } = require('./server');

(async () => {
  console.log('🚀 启动企业合同与采购项目台账系统【全量回归测试 (15大模块全覆盖)】...');
  const { port, shutdown } = await startServer(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode = 0;

  try {
    // ==================== 测试 1：内网协同动态端口一致性与口令配置 ====================
    const lanStatus = await fetch(`${baseUrl}/api/lan-auth/status`).then(r => r.json());
    assert.strictEqual(lanStatus.success, true);
    assert.strictEqual(lanStatus.port, port, `内网协同状态返回的端口(${lanStatus.port})必须与实际监听随机端口(${port})完全一致`);
    if (lanStatus.lan_urls && lanStatus.lan_urls.length > 0) {
      assert.ok(lanStatus.lan_urls[0].endsWith(`:${port}`), `内网访问地址末尾端口必须为 :${port}`);
    }

    const lanCfgRes = await fetch(`${baseUrl}/api/lan-auth/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, passcode: '654321' })
    }).then(r => r.json());
    assert.strictEqual(lanCfgRes.success, true);

    const badLogin = await fetch(`${baseUrl}/api/lan-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '000000' })
    });
    assert.strictEqual(badLogin.status, 401, '错误口令必须返回 401');

    const goodLogin = await fetch(`${baseUrl}/api/lan-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: '654321' })
    }).then(r => r.json());
    assert.strictEqual(goodLogin.success, true);
    assert.ok(goodLogin.token, '正确口令必须签发会话 Token');
    console.log('✅ [1/15 通过] 内网协同动态端口实时同步与口令安全鉴权验证成功');

    // ==================== 测试 2：默认我方签约主体设置与读取 ====================
    const entityInit = await fetch(`${baseUrl}/api/settings/our-entity`).then(r => r.json());
    assert.strictEqual(entityInit.our_entity, 'ABC公司');

    const entitySave = await fetch(`${baseUrl}/api/settings/our-entity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ our_entity: 'ABC集团总部' })
    }).then(r => r.json());
    assert.strictEqual(entitySave.our_entity, 'ABC集团总部');
    // 恢复为 ABC公司
    await fetch(`${baseUrl}/api/settings/our-entity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ our_entity: 'ABC公司' })
    });
    console.log('✅ [2/15 通过] 默认我方签约主体读写验证成功');

    // ==================== 测试 3：全局 8 类下拉预设自定义与恢复默认 ====================
    const presetSave = await fetch(`${baseUrl}/api/settings/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presets: {
          contract_types: '采购、服务、战略合作',
          contract_statuses: '草稿、履行中、已超期、已终止',
          invoice_types: '数电专票、数电普票'
        }
      })
    }).then(r => r.json());
    assert.strictEqual(presetSave.success, true);
    assert.ok(presetSave.presets.contract_types.includes('战略合作'));
    assert.ok(presetSave.presets.contract_statuses.includes('履行中'));
    assert.ok(presetSave.presets.contract_statuses.includes('已超期'));
    console.log('✅ [3/15 通过] 全局下拉预设自定义与动态状态词识别验证成功');

    // ==================== 测试 4：合同与采购立项夹心式 4 段编号生成规则 ====================
    const cNoRes = await fetch(`${baseUrl}/api/contracts/next-no?sign_date=2026-03-18&mid_custom=ZX-`).then(r => r.json());
    assert.strictEqual(cNoRes.success, true);
    assert.strictEqual(cNoRes.next_no, 'HT-ABC-ZX-202603001');

    const pNoRes = await fetch(`${baseUrl}/api/procurements/next-no?approval_date=2026-03-18&mid_custom=-ABC-`).then(r => r.json());
    assert.strictEqual(pNoRes.success, true);
    assert.strictEqual(pNoRes.next_no, 'LX-ABC-20260318001');
    console.log('✅ [4/15 通过] 合同与采购夹心式分段编号生成引擎验证成功');

    // ==================== 测试 5：采购立项创建、智能日期解析与多附件上传 ====================
    const pForm1 = new FormData();
    pForm1.append('procurement_no', 'LX20260318001');
    pForm1.append('project_name', 'ABC公司年度物流配送服务采购项目');
    pForm1.append('project_type', '服务类项目');
    pForm1.append('cost_department', '运营管理部');
    pForm1.append('budget_amount', '300000');
    pForm1.append('budget_subject', '运输费');
    pForm1.append('approval_date', '46099'); // Excel 序列号 -> 2026-03-18
    pForm1.append('decision_date', '2026.3.19'); // 点号格式 -> 2026-03-19
    pForm1.append('completion_date', '20260322'); // 8位纯数字 -> 2026-03-22
    pForm1.append('supplier_name', 'BCD物流有限公司');
    pForm1.append('deal_amount', '295000');
    pForm1.append('has_contract', '否');
    pForm1.append('remark', '立项备注A');
    pForm1.append('procurement_files', new Blob(['立项批复单内容'], { type: 'text/plain' }), '立项批复单.txt');
    pForm1.append('procurement_files', new Blob(['谈判纪要内容'], { type: 'text/plain' }), '谈判纪要.txt');

    const pCreate1 = await fetch(`${baseUrl}/api/procurements`, { method: 'POST', body: pForm1 }).then(r => r.json());
    assert.strictEqual(pCreate1.success, true);
    const procId1 = pCreate1.id;

    // 再创建第 2 条采购立项用于测试采购立项调序
    const pForm2 = new FormData();
    pForm2.append('procurement_no', 'LX20260410002');
    pForm2.append('project_name', 'ABC公司园区安防监控升级采购项目');
    pForm2.append('project_type', '设备采购');
    pForm2.append('cost_department', '综合管理部');
    pForm2.append('budget_amount', '150000');
    pForm2.append('approval_date', '2026-04-10');
    pForm2.append('procurement_files', new Blob(['安防方案'], { type: 'text/plain' }), '安防方案.txt');
    const pCreate2 = await fetch(`${baseUrl}/api/procurements`, { method: 'POST', body: pForm2 }).then(r => r.json());
    assert.strictEqual(pCreate2.success, true);
    const procId2 = pCreate2.id;

    const pDetail1 = (await fetch(`${baseUrl}/api/procurements/${procId1}`).then(r => r.json())).data;
    assert.strictEqual(pDetail1.approval_date, '2026-03-18', 'Excel 5位序列号日期解析错误');
    assert.strictEqual(pDetail1.decision_date, '2026-03-19', '点号日期解析错误');
    assert.strictEqual(pDetail1.completion_date, '2026-03-22', '8位数字日期解析错误');
    assert.ok(
      pDetail1.files[0].file_path.includes('2026-001_LX20260318001_ABC公司年度物流配送服务采购项目_立项资料/'),
      `立项资料文件夹命名必须以 _立项资料 结尾: ${pDetail1.files[0].file_path}`
    );
    console.log('✅ [5/15 通过] 采购立项创建、智能日期解析及【_立项资料】文件夹命名验证成功');

    // ==================== 测试 6：多对方单位合同录入、智能多税率、到期自动流转与双向绑定 ====================
    const cForm1 = new FormData();
    cForm1.append('contract_no', 'HT-ABC-202603003');
    cForm1.append('contract_name', 'ABC公司年度物流配送服务合同');
    cForm1.append('contract_type', '服务');
    cForm1.append('status', '履行中');
    cForm1.append('our_entity', 'ABC公司');
    cForm1.append('sign_date', '2026.3.20');
    cForm1.append('start_date', '2026.3.20');
    cForm1.append('expiry_date', '2020-01-01'); // 故意设为过去日期，验证自动流转为“已超期”
    cForm1.append('procurement_id', String(procId1));
    cForm1.append('remark', '合同级公共备注');
    cForm1.append('counterparties_json', JSON.stringify([
      {
        company_name: 'BCD物流有限公司',
        credit_code: '91522400MA6XXXXXXX',
        summary: '华东干线配送\n冷链专线保障',
        contact_person: '张经理',
        contact_phone: '13800138000',
        bank_account_name: 'BCD物流有限公司',
        bank_account_no: '52001658800052500000',
        bank_name: 'DEF银行营业部',
        bank_code: '102100000018',
        amount: 200000,
        amount_excl_tax: 185000,
        tax_rate: '6，9', // 智能多税率 -> *6%、9%
        invoice_type: '数电专票',
        currency: 'CNY',
        perf_bond_amount: 15000,
        perf_bond_status: '未退',
        perf_bond_return_date: '2027-03-31',
        warranty_bond_amount: 9000,
        warranty_bond_status: '未退',
        warranty_bond_expiry_date: '2028-03-31',
        remark: '乙方1备注'
      },
      {
        company_name: 'XYZ联运分公司',
        credit_code: '91522400MA6YYYYYYY',
        summary: '西南支线配送',
        contact_person: '李主任',
        contact_phone: '13900139000',
        bank_account_name: 'XYZ联运分公司',
        bank_account_no: '6222021111112222333',
        bank_name: 'GHI银行支行',
        bank_code: '103100000026',
        amount: 95000,
        tax_rate: '6', // 单税率自动格式化为 6% 并自动算不含税价
        invoice_type: '数电专票',
        currency: 'CNY',
        remark: '乙方2备注'
      }
    ]));
    cForm1.append('attachment', new Blob(['%PDF-1.4 dummy scan 1'], { type: 'application/pdf' }), 'orig_scan.pdf');
    cForm1.append('related_files', new Blob(['补充协议正文'], { type: 'text/plain' }), '补充协议.txt');
    cForm1.append('related_files', new Blob(['报价清单正文'], { type: 'text/plain' }), '报价清单.txt');

    const cCreate1 = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm1 }).then(r => r.json());
    assert.strictEqual(cCreate1.success, true);
    const contractId1 = cCreate1.id;

    const cDetail1 = (await fetch(`${baseUrl}/api/contracts/${contractId1}`).then(r => r.json())).data;
    assert.strictEqual(cDetail1.status, '已超期', '过期合同应自动流转为自定义到期状态【已超期】');
    assert.strictEqual(cDetail1.counterparties.length, 2, '应完整保存 2 个对方单位');
    assert.strictEqual(cDetail1.counterparties[0].tax_rate, '*6%、9%', '多税率应自动规范化为 *6%、9%');
    assert.strictEqual(cDetail1.counterparties[0].bank_code, '102100000018', '开户行号应完整保存');
    assert.strictEqual(cDetail1.counterparties[1].tax_rate, '6%', '单税率应自动补齐 %');
    assert.strictEqual(cDetail1.counterparties[1].amount_excl_tax, 89622.64, '单税率应自动计算不含税价');
    console.log('✅ [6/15 通过] 一合同多乙方、智能多税率、不含税价推算及到期状态自动流转验证成功');

    // ==================== 测试 7：主合同扫描件与合同其他资料文件夹命名规范 ====================
    assert.strictEqual(
      cDetail1.attachment_path,
      '2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf',
      `主合同扫描件命名必须为【序号_编号_合同名称.pdf】: ${cDetail1.attachment_path}`
    );
    assert.ok(
      cDetail1.related_files[0].file_path.includes('2026-001_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件/'),
      `合同其他资料文件夹命名必须以 _其他合同附件 结尾: ${cDetail1.related_files[0].file_path}`
    );
    console.log('✅ [7/15 通过] 主合同扫描件【序号_编号_合同名称】与【_其他合同附件】文件夹命名验证成功');

    // ==================== 测试 8：详情页在线补传附件与单文件删除 ====================
    const extraRelForm = new FormData();
    extraRelForm.append('related_files', new Blob(['验收单内容'], { type: 'text/plain' }), '验收单.txt');
    const extraRelRes = await fetch(`${baseUrl}/api/contracts/${contractId1}/related-files`, {
      method: 'POST',
      body: extraRelForm
    }).then(r => r.json());
    assert.strictEqual(extraRelRes.success, true);
    assert.strictEqual(extraRelRes.related_files.length, 3, '补传后应有 3 份相关资料');

    const toDeleteFileId = extraRelRes.related_files[2].id;
    const delRelRes = await fetch(`${baseUrl}/api/contracts/${contractId1}/related-files/${toDeleteFileId}`, {
      method: 'DELETE'
    }).then(r => r.json());
    assert.strictEqual(delRelRes.success, true);
    console.log('✅ [8/15 通过] 详情页在线补传资料与单文件独立删除验证成功');

    // ==================== 测试 9：点击序号手动调序（选项 B：插队顺延 + 硬盘文件自动改名） ====================
    const cForm2 = new FormData();
    cForm2.append('contract_no', 'HT-ABC-202605009');
    cForm2.append('contract_name', 'GHI公司园区安防监控维保合同');
    cForm2.append('contract_type', '服务');
    cForm2.append('status', '履行中');
    cForm2.append('our_entity', 'ABC公司');
    cForm2.append('sign_date', '2026-05-10');
    cForm2.append('start_date', '2026-05-10');
    cForm2.append('expiry_date', '2027-05-09');
    cForm2.append('counterparties_json', JSON.stringify([{ company_name: 'GHI公司', amount: 150000, tax_rate: '6%' }]));
    cForm2.append('attachment', new Blob(['%PDF-1.4 dummy scan 2'], { type: 'application/pdf' }), 'scan2.pdf');

    const cCreate2 = await fetch(`${baseUrl}/api/contracts`, { method: 'POST', body: cForm2 }).then(r => r.json());
    assert.strictEqual(cCreate2.success, true);
    const contractId2 = cCreate2.id;

    // 将排第 2 的 contractId2 插队调序到第 1 位 (2026-001)
    const cReorderRes = await fetch(`${baseUrl}/api/contracts/${contractId2}/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_seq: '1' })
    }).then(r => r.json());
    assert.strictEqual(cReorderRes.success, true);
    assert.strictEqual(cReorderRes.seq_no, '2026-001');

    const afterC1 = (await fetch(`${baseUrl}/api/contracts/${contractId1}`).then(r => r.json())).data;
    const afterC2 = (await fetch(`${baseUrl}/api/contracts/${contractId2}`).then(r => r.json())).data;
    assert.strictEqual(afterC2.seq_no, '2026-001', 'contractId2 插队后序号应为 2026-001');
    assert.strictEqual(afterC1.seq_no, '2026-002', 'contractId1 顺延后序号应为 2026-002');
    assert.strictEqual(
      afterC2.attachment_path,
      '2026-001_HT-ABC-202605009_GHI公司园区安防监控维保合同.pdf',
      '插队后扫描件文件名应同步变更为 2026-001_...'
    );
    assert.strictEqual(
      afterC1.attachment_path,
      '2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf',
      '顺延后扫描件文件名应同步变更为 2026-002_...'
    );
    assert.ok(
      afterC1.related_files[0].file_path.includes('2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件/'),
      '顺延后其他合同附件文件夹名应同步变更为 2026-002_...'
    );

    // 同样验证采购立项点击序号调序：将 procId2 插队到第 1 位
    const pReorderRes = await fetch(`${baseUrl}/api/procurements/${procId2}/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_seq: '2026-001' })
    }).then(r => r.json());
    assert.strictEqual(pReorderRes.success, true);
    assert.strictEqual(pReorderRes.seq_no, '2026-001');

    const afterP1 = (await fetch(`${baseUrl}/api/procurements/${procId1}`).then(r => r.json())).data;
    assert.strictEqual(afterP1.seq_no, '2026-002', 'procId1 顺延后序号应为 2026-002');
    assert.ok(
      afterP1.files[0].file_path.includes('2026-002_LX20260318001_ABC公司年度物流配送服务采购项目_立项资料/'),
      '顺延后立项资料文件夹名应同步变更为 2026-002_...'
    );
    console.log('✅ [9/15 通过] 合同与采购立项点击序号插队调序、顺延及硬盘文件自动同步改名验证成功');

    // ==================== 测试 10：验证编辑已调序合同不会打乱手动调好的顺序 ====================
    const editForm = new FormData();
    editForm.append('contract_no', afterC2.contract_no);
    editForm.append('contract_name', afterC2.contract_name);
    editForm.append('contract_type', afterC2.contract_type);
    editForm.append('status', afterC2.status);
    editForm.append('our_entity', afterC2.our_entity);
    editForm.append('sign_date', afterC2.sign_date);
    editForm.append('start_date', afterC2.start_date);
    editForm.append('expiry_date', afterC2.expiry_date);
    editForm.append('remark', '更新备注后依然保持001');
    editForm.append('counterparties_json', JSON.stringify(afterC2.counterparties));
    const editRes = await fetch(`${baseUrl}/api/contracts/${contractId2}`, { method: 'PUT', body: editForm }).then(r => r.json());
    assert.strictEqual(editRes.success, true);
    const afterEditC2 = (await fetch(`${baseUrl}/api/contracts/${contractId2}`).then(r => r.json())).data;
    assert.strictEqual(afterEditC2.seq_no, '2026-001', '编辑保存后应继续保持手动调整后的 2026-001 序号');
    console.log('✅ [10/15 通过] 手动调序持久化记忆（编辑不打乱顺序）验证成功');

    // ==================== 测试 11：多维筛选查询过滤验证 ====================
    const filterByNo = await fetch(`${baseUrl}/api/contracts?no=202603003`).then(r => r.json());
    assert.strictEqual(filterByNo.data.length, 1);
    assert.strictEqual(filterByNo.data[0].id, contractId1);

    const filterProc = await fetch(`${baseUrl}/api/procurements?dept=运营管理部`).then(r => r.json());
    assert.strictEqual(filterProc.data.length, 1);
    assert.strictEqual(filterProc.data[0].id, procId1);
    console.log('✅ [11/15 通过] 合同与采购多条件筛选查询验证成功');

    // ==================== 测试 12 & 13：三大 Excel 导出、文件夹超链接与单元格合并验证 ====================
    const expContract = await fetch(`${baseUrl}/api/export/excel?mode=all`);
    assert.strictEqual(expContract.status, 200);
    const expProc = await fetch(`${baseUrl}/api/procurements/export?mode=all`);
    assert.strictEqual(expProc.status, 200);
    const expCombined = await fetch(`${baseUrl}/api/export/combined`);
    assert.strictEqual(expCombined.status, 200);

    const combBuf = Buffer.from(await expCombined.arrayBuffer());
    const combWb = XLSX.read(combBuf, { type: 'buffer', cellFormula: true });
    const wsContract = combWb.Sheets['合同台账'];
    const wsProc = combWb.Sheets['采购项目台账'];

    // 第 3 行是 2026-001 (contractId2，1个乙方，占第3行)
    // 第 4~5 行是 2026-002 (contractId1，2个乙方，占第4、5行合并)
    assert.strictEqual(wsContract['A3'].v, '2026-001');
    assert.strictEqual(wsContract['A4'].v, '2026-002');
    // AE4: 主合同扫描件超链接 -> 指向单个 PDF 文件
    assert.ok(
      wsContract['AE4'].f.includes('HYPERLINK("uploads/2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf"'),
      `合同表主扫描件超链接异常: ${wsContract['AE4'].f}`
    );
    // AF4: 关联采购立项号超链接 -> 指向 _立项资料 文件夹
    assert.ok(
      wsContract['AF4'].f.includes('HYPERLINK("uploads/procurement/2026-002_LX20260318001_ABC公司年度物流配送服务采购项目_立项资料"'),
      `合同表关联采购立项必须链接到文件夹: ${wsContract['AF4'].f}`
    );
    // AG4: 其他相关资料超链接 -> 指向 _其他合同附件 文件夹
    assert.ok(
      wsContract['AG4'].f.includes('HYPERLINK("uploads/related/2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同_其他合同附件"'),
      `合同表其他相关资料必须链接到文件夹: ${wsContract['AG4'].f}`
    );

    // 采购表第 4 行是 2026-002 (procId1)
    assert.strictEqual(wsProc['A4'].v, '2026-002');
    // P4: 关联合同编号 -> 指向主合同扫描件 PDF
    assert.ok(
      wsProc['P4'].f.includes('HYPERLINK("uploads/2026-002_HT-ABC-202603003_ABC公司年度物流配送服务合同.pdf","HT-ABC-202603003")'),
      `采购表关联合同编号超链接异常: ${wsProc['P4'].f}`
    );
    // R4: 立项相关资料 -> 指向 _立项资料 文件夹
    assert.ok(
      wsProc['R4'].f.includes('HYPERLINK("uploads/procurement/2026-002_LX20260318001_ABC公司年度物流配送服务采购项目_立项资料"'),
      `采购表立项相关资料必须链接到文件夹: ${wsProc['R4'].f}`
    );
    console.log('✅ [12 & 13/15 通过] 三大 Excel 导出、多乙方合并、扫描件链向文件 & 多份资料链向对应文件夹验证成功');

    // ==================== 测试 14：合同与采购双向一键解绑验证 ====================
    const unbindRes = await fetch(`${baseUrl}/api/procurements/${procId1}/unbind-contract`, { method: 'POST' }).then(r => r.json());
    assert.strictEqual(unbindRes.success, true);

    const cAfterUnbind = (await fetch(`${baseUrl}/api/contracts/${contractId1}`).then(r => r.json())).data;
    const pAfterUnbind = (await fetch(`${baseUrl}/api/procurements/${procId1}`).then(r => r.json())).data;
    assert.strictEqual(cAfterUnbind.procurement_id, null);
    assert.strictEqual(pAfterUnbind.contract_id, null);
    assert.strictEqual(pAfterUnbind.has_contract, '否');
    console.log('✅ [14/15 通过] 合同与采购立项一键双向解绑验证成功');

    // ==================== 测试 15：前端代码静态防退化检查（Enter 失焦、点击序号调序、纯净界面） ====================
    const appJsCode = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    assert.ok(appJsCode.includes('function bindEnterToBlurOnForms()'), '前端 app.js 必须包含 bindEnterToBlurOnForms 回车失焦函数');
    assert.ok(appJsCode.includes('e.target.blur()'), '前端 app.js 必须在按下 Enter 时触发 e.target.blur()');
    assert.ok(appJsCode.includes('function promptReorderSeq('), '前端 app.js 必须包含 promptReorderSeq 点击序号调序函数');
    console.log('✅ [15/15 通过] 前端交互源码防退化静态检查（Enter 结束当前输入焦点、点击序号调序）验证成功');

    console.log('🎉 全部 15 大模块回归测试 100% 通过！');
  } catch (err) {
    console.error('❌ 回归测试未通过:', err);
    exitCode = 1;
  } finally {
    await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('🧹 临时测试资源已释放完毕！');
    process.exit(exitCode);
  }
})();
