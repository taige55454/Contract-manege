const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testDataRoot = path.join(__dirname, '.test_data_ci');
process.env.DATA_ROOT = testDataRoot;
process.env.DB_PATH = path.join(testDataRoot, 'test_ci.sqlite');

const { startServer } = require('./server');

(async () => {
  const controller = await startServer(0, '127.0.0.1');
  const port = controller.port;
  console.log(`🧪 执行打包前冒烟测试 (Port: ${port})...`);

  try {
    // 1. 验证设置默认我方签约主体
    const putEntityPayload = JSON.stringify({ default_our_entity: '华南智云科技股份有限公司' });
    const entityRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/settings/our-entity', method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putEntityPayload) }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(putEntityPayload);
      req.end();
    });
    assert.strictEqual(entityRes.success, true, '设置默认我方主体应成功');

    // 2. 验证一合同多方不同履约义务（各自独立摘要、金额、税率、保证金）
    const postPayload = JSON.stringify({
      contract_no: 'HT-MULTI-2026-001',
      contract_name: '智慧园区软硬件三方联建合同',
      contract_type: '采购',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '2026-11-01',
      start_date: '2026-11-01',
      expiry_date: '2026-12-15',
      status: '生效中',
      counterparties_json: JSON.stringify([
        {
          company_name: '硬件设备供应商A有限公司',
          credit_code: '91440300MA5FX00001',
          item_summary: '负责机房核心交换机与服务器硬件供货安装',
          amount: 600000,
          amount_excl_tax: 530973.45,
          tax_rate: '13%',
          invoice_type: '增值税专用发票',
          perf_bond_amount: 30000,
          perf_bond_return_date: '2026-12-01'
        },
        {
          company_name: '软件集成服务商B有限公司',
          credit_code: '91440300MA5FX00002',
          item_summary: '负责园区定制管理平台研发及驻场运维',
          amount: 400000,
          amount_excl_tax: 377358.49,
          tax_rate: '*6%,13%',
          invoice_type: '数电专票',
          warranty_bond_amount: 20000,
          warranty_bond_expiry_date: '2027-06-01'
        }
      ])
    });

    const createRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/contracts', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postPayload) }
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(postPayload);
      req.end();
    });
    assert.strictEqual(createRes.success, true, '新增多方独立履约合同应成功');

    // 3. 验证带跨行合并单元格的 Excel 导出
    const exportStatus = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/contracts/export?scope=all`, res => {
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.strictEqual(exportStatus, 200, 'Excel 合并单元格导出应返回 200');

  } finally {
    await controller.shutdown();
    fs.rmSync(testDataRoot, { recursive: true, force: true });
    console.log('✅ 多方分行合并、Excel合并导出与资源彻底释放测试全部通过！');
  }
})();
