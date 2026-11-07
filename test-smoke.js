const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const XLSX = require('xlsx-js-style');

const testDataRoot = path.join(__dirname, '.test_data_ci');
process.env.DATA_ROOT = testDataRoot;
process.env.DB_PATH = path.join(testDataRoot, 'test_ci.sqlite');

const { startServer } = require('./server');

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

(async () => {
  let controller = null;
  try {
    controller = await startServer(0, '127.0.0.1');
    const port = controller.port;
    console.log(`🧪 执行打包前全功能冒烟测试 (Port: ${port})...`);

    // 1. 验证默认我方主体修改接口
    const entityRes = await requestJson(port, '/api/settings/our-entity', 'PUT', {
      default_our_entity: '华南智云科技股份有限公司'
    });
    assert.strictEqual(entityRes.success, true, '设置默认我方主体应成功');

    // 2. 验证编号规则与按年断号重编设置
    const ruleRes = await requestJson(port, '/api/settings/contract-no-rule', 'PUT', {
      prefix: 'ZN-',
      date_part: 'YYYY-',
      seq_digits: 3,
      suffix: '-CG',
      reset_yearly: true
    });
    assert.strictEqual(ruleRes.success, true, '保存合同编号规则应成功');

    // 3. 故意先录入较晚日期的合同，再录入较早日期的合同，检验是否自动按 001、002 正序排列
    const c2 = await requestJson(port, '/api/contracts', 'POST', {
      contract_no: 'ZN-2026-002-CG',
      contract_name: '第二份合同(较晚签订)',
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
          bank_account_no: '6222021234567890123',
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
      contract_name: '第一份合同(较早签订)',
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

    // 4. 验证导出 Excel 二进制流：
    //    - 第1行(r=0)为黄色目录结构说明横幅
    //    - 第2行(r=1)为表头
    //    - 第3行(r=2)必须是 2026-001（正序排第一），第4行(r=3)必须是 2026-002（正序排第二）
    //    - 日期单元格必须是纯整数 (Number.isInteger)，不含任何时分秒小数
    const excelBuffer = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/contracts/export?scope=all`, res => {
        assert.strictEqual(res.statusCode, 200, '导出状态码应为 200');
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });

    const wb = XLSX.read(excelBuffer, { type: 'buffer', cellNF: true });
    const ws = wb.Sheets['合同台账'];

    assert.strictEqual(ws['A3'].v, '2026-001', '导出第1条数据行必须按正序排列为 2026-001');
    assert.strictEqual(ws['A4'].v, '2026-002', '导出第2条数据行必须按正序排列为 2026-002');
    assert.strictEqual(Number.isInteger(ws['F3'].v), true, '导出签订日期序列号必须为纯整数（绝不含时分秒小数）');
    assert.strictEqual(Number.isInteger(ws['AB4'].v), true, '导出质保金到期日序列号必须为纯整数（绝不含时分秒小数）');

    // 5. 验证彻底释放端口与 SQLite 文件句柄
    await controller.shutdown();
    controller = null;
    fs.rmSync(testDataRoot, { recursive: true, force: true });
    console.log('✅ 纯年月日无时分秒、扫描件相对路径超链接、按001/002正序导出与资源释放测试全部通过！');
    process.exit(0);
  } catch (err) {
    console.error('❌ 冒烟测试失败:', err);
    if (controller) {
      try { await controller.shutdown(); } catch (e) {}
    }
    process.exit(1);
  }
})();
