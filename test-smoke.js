const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const XLSX = require('xlsx-js-style');

const testDataRoot = path.join(__dirname, '.test_data_ci');
process.env.DATA_ROOT = testDataRoot;
process.env.DB_PATH = path.join(testDataRoot, 'test_ci.sqlite');

const { startServer, sweepOrphanUploads } = require('./server');

function requestJson(port, reqPath, method = 'GET', payloadObj = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = payloadObj ? JSON.stringify(payloadObj) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: bodyStr
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
        : {}
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function uploadMultipartFiles(port, reqPath, fieldName, filesArray) {
  return new Promise((resolve, reject) => {
    const boundary = '----ContractSmokeBoundary' + Date.now();
    const chunks = [];

    for (const f of filesArray) {
      chunks.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${f.filename}"\r\n` +
        `Content-Type: ${f.mime || 'application/pdf'}\r\n\r\n`
      ));
      chunks.push(Buffer.from(f.content));
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

(async () => {
  let controller = null;
  try {
    controller = await startServer(0, '127.0.0.1');
    const port = controller.port;
    console.log(`🧪 执行终极全链路稳定性与异常回滚冒烟测试 (Port: ${port})...`);

    // 1. 验证默认我方主体与编号规则设置
    await requestJson(port, '/api/settings/our-entity', 'PUT', {
      default_our_entity: '华南智云科技股份有限公司'
    });
    await requestJson(port, '/api/settings/contract-no-rule', 'PUT', {
      prefix: 'ZN-',
      date_part: 'YYYY-',
      seq_digits: 3,
      suffix: '-CG',
      reset_yearly: true
    });

    // 2. 创建两份合同，验证按 001、002 正序排列
    const c2 = await requestJson(port, '/api/contracts', 'POST', {
      contract_no: 'ZN-2026-002-CG',
      contract_name: '二期硬件采购合同',
      contract_type: '采购',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '2026.8.15',
      start_date: '2026.8.15',
      expiry_date: '2027/1/29',
      status: '生效中',
      counterparties_json: JSON.stringify([
        {
          company_name: '硬件供应商B',
          credit_code: '91440300MA5FX00002',
          amount: 500000,
          tax_rate: '6，13',
          warranty_bond_amount: 4212,
          warranty_bond_expiry_date: '2027/1/29'
        }
      ])
    });
    assert.strictEqual(c2.success, true);

    const c1 = await requestJson(port, '/api/contracts', 'POST', {
      contract_no: 'ZN-2026-001-CG',
      contract_name: '一期软件开发合同',
      contract_type: '服务',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '2026.3.5',
      start_date: '2026/3/5',
      expiry_date: '2026-12-31',
      status: '生效中',
      counterparties_json: JSON.stringify([
        {
          company_name: '服务商A',
          credit_code: '91440300MA5FX00001',
          amount: 100000,
          tax_rate: '6'
        }
      ])
    });
    assert.strictEqual(c1.success, true);

    // 3. 为第一份合同上传 2 份“其他关联资料”，验证专属文件夹自动创建
    const relUploadRes = await uploadMultipartFiles(port, `/api/contracts/${c1.id}/related`, 'related_files', [
      { filename: '1#立项批复文件.pdf', content: '%PDF-1.4 dummy 1' },
      { filename: '招标会议纪要.docx', content: 'docx dummy 2' }
    ]);
    assert.strictEqual(relUploadRes.success, true, '多文件关联资料上传应成功');
    const originalFolderRel = 'uploads/related/ZN-2026-001-CG+一期软件开发合同+2026-03-05';
    assert.strictEqual(relUploadRes.related_folder_path, originalFolderRel);

    // 4. 【异常回滚测试】故意将 c1 的编号改成与 c2 重名的 'ZN-2026-002-CG'，验证被拦截且原文件夹毫发无损
    const conflictUpdateRes = await requestJson(port, `/api/contracts/${c1.id}`, 'PUT', {
      contract_no: 'ZN-2026-002-CG',
      contract_name: '故意制造重名冲突的名称',
      contract_type: '服务',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '2026-03-10',
      start_date: '2026-03-10',
      expiry_date: '2026-12-31',
      status: '生效中',
      counterparties_json: JSON.stringify([
        { company_name: '服务商A', credit_code: '91440300MA5FX00001', amount: 100000 }
      ])
    });
    assert.strictEqual(conflictUpdateRes.success, false, '重复编号更新应当被安全拦截');
    assert.strictEqual(
      fs.existsSync(path.join(testDataRoot, originalFolderRel, '1#立项批复文件.pdf')),
      true,
      '当更新因编号冲突被拦截时，原关联资料文件夹绝不能被误改名或破坏'
    );

    // 5. 【正常联动改名测试】修改第一份合同的名称与签订日期，验证专属文件夹自动同步重命名
    const updateRes = await requestJson(port, `/api/contracts/${c1.id}`, 'PUT', {
      contract_no: 'ZN-2026-001-CG',
      contract_name: '一期软件升级合同(已改名)',
      contract_type: '服务',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '2026-03-10',
      start_date: '2026-03-10',
      expiry_date: '2026-12-31',
      status: '生效中',
      counterparties_json: JSON.stringify([
        {
          company_name: '服务商A',
          credit_code: '91440300MA5FX00001',
          amount: 100000,
          tax_rate: '6%'
        }
      ])
    });
    assert.strictEqual(updateRes.success, true, '更新合同信息应成功');

    const expectedNewFolderRel = 'uploads/related/ZN-2026-001-CG+一期软件升级合同(已改名)+2026-03-10';
    assert.strictEqual(
      fs.existsSync(path.join(testDataRoot, expectedNewFolderRel, '1#立项批复文件.pdf')),
      true,
      '修改合同名称和日期后，关联资料专属文件夹必须自动同步改名且内部文件完好无损'
    );

    // 6. 验证导出 Excel 二进制流
    const excelBuffer = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/contracts/export?scope=all`, res => {
        assert.strictEqual(res.statusCode, 200);
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });

    const wb = XLSX.read(excelBuffer, { type: 'buffer', cellNF: true });
    const ws = wb.Sheets['合同台账'];

    assert.strictEqual(ws['A3'].v, '2026-001', '导出第1条数据行必须按正序排列为 2026-001');
    assert.strictEqual(Number.isInteger(ws['F3'].v), true, '导出签订日期必须为纯整数序列号');
    assert.strictEqual(ws['AE3'].l.Target, expectedNewFolderRel, '导出表第31列超链接必须指向重命名后的关联资料专属文件夹');

    // 7. 验证孤儿文件清扫与关闭资源释放
    sweepOrphanUploads();
    await controller.shutdown();
    controller = null;
    fs.rmSync(testDataRoot, { recursive: true, force: true });
    console.log('✅ 终极全局稳定性、异常回滚保护、文件夹联动改名与 Excel 超链接测试 100% 通过！');
    process.exit(0);
  } catch (err) {
    console.error('❌ 冒烟测试失败:', err);
    if (controller) {
      try { await controller.shutdown(); } catch (e) {}
    }
    process.exit(1);
  }
})();
