const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 使用独立测试数据库，避免污染正式数据
process.env.DB_PATH = path.join(__dirname, 'test_ci.sqlite');
const { app, db } = require('./server');

const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log(`🧪 正在执行 CI 自动化冒烟测试 (Port: ${port})...`);

  try {
    // 1. 验证多方签约、多税率(*6%,13%)、不含税价、保证金与质保金入库
    const postPayload = JSON.stringify({
      contract_no: 'HT-CI-2026-001',
      contract_name: '云平台联合研发合同',
      contract_summary: '包含IaaS底座搭建与三年联合运维服务',
      contract_type: '服务',
      our_entity: '华南智云总部、华南智云北京研究院',
      sign_date: '2026-11-01',
      start_date: '2026-11-05',
      expiry_date: '2026-11-25',
      amount: 1060000,
      amount_excl_tax: 1000000,
      tax_rate: '*6%,13%',
      invoice_type: '增值税专用发票',
      currency: 'CNY',
      perf_bond_amount: 50000,
      perf_bond_pay_date: '2026-11-02',
      perf_bond_return_date: '2026-11-20',
      warranty_bond_amount: 30000,
      warranty_bond_expiry_date: '2026-12-01',
      status: '生效中',
      counterparties_json: JSON.stringify([
        { company_name: '甲骨文华南技术有限公司', credit_code: '91440300MA5FX12345', contact_person: '张经理', contact_phone: '13800138000' },
        { company_name: '深信服网络科技有限公司', credit_code: '91440300MA5FX67890', bank_name: '招商银行深圳分行', bank_account_no: '7559000111' }
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

    assert.strictEqual(createRes.success, true, '新增多方合同应当成功');

    // 2. 验证 Excel 导出接口正常返回二进制流
    const exportStatus = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/contracts/export?scope=all`, res => {
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.strictEqual(exportStatus, 200, 'Excel 导出接口应返回 HTTP 200');

    console.log('✅ 所有 CI 编译与业务冒烟测试全部通过！');
  } catch (err) {
    console.error('❌ 测试失败:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    db.close();
    if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
  }
});
