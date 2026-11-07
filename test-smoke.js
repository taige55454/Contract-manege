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
    const postPayload = JSON.stringify({
      contract_no: 'HT-EXE-2026-001',
      contract_name: '数据中心二期建设合同',
      contract_summary: '核心机柜与精密空调采购及安装',
      contract_type: '采购',
      our_entity: '华南智云科技总部',
      sign_date: '2026-11-01',
      start_date: '2026-11-01',
      expiry_date: '2026-12-01',
      amount: 500000,
      amount_excl_tax: 442477.88,
      tax_rate: '*6%,13%',
      invoice_type: '增值税专用发票',
      currency: 'CNY',
      status: '生效中',
      counterparties_json: JSON.stringify([
        { company_name: '精密设备有限公司', credit_code: '91440300MA5FX99999' }
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

    assert.strictEqual(createRes.success, true, '新增合同应成功');
  } finally {
    // 验证 shutdown() 是否能彻底释放 SQLite 文件锁（若未释放，Windows 下删除文件会报 EBUSY 失败）
    await controller.shutdown();
    fs.rmSync(testDataRoot, { recursive: true, force: true });
    console.log('✅ 业务逻辑与进程句柄彻底释放测试通过！');
  }
})();
