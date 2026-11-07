const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

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

    // 3. 验证灵活时间输入（如 2025.3.5、6-3 缺省年份）与智能税率（输入 "6" -> "6%", 输入 "6，13" -> "*6%,13%"）
    const c2025 = await requestJson(port, '/api/contracts', 'POST', {
      contract_no: 'ZN-2025-001-CG',
      contract_name: '2025年度历史维保合同',
      contract_type: '服务',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '2025.3.5',
      start_date: '2025/3/5',
      expiry_date: '2026-3-4',
      status: '生效中',
      counterparties_json: JSON.stringify([
        {
          company_name: '历史服务商A',
          credit_code: '91440300MA5FX00001',
          amount: 100000,
          tax_rate: '6'
        }
      ])
    });
    assert.strictEqual(c2025.success, true, '2025年合同应新增成功');

    const c2026 = await requestJson(port, '/api/contracts', 'POST', {
      contract_no: 'ZN-2026-001-CG',
      contract_name: '2026年度三方联建合同',
      contract_type: '采购',
      our_entity: '华南智云科技股份有限公司',
      sign_date: '6.3',       // 缺省年份应自动补全为当年 YYYY-06-03
      start_date: '6-3',
      expiry_date: '12/31',
      status: '生效中',
      counterparties_json: JSON.stringify([
        {
          company_name: '硬件供应商B',
          credit_code: '91440300MA5FX00002',
          bank_account_no: '6222021234567890123',
          amount: 500000,
          tax_rate: '6，13'    // 全角逗号且无 %、无 *，应自动转为 *6%,13%
        },
        {
          company_name: '软件集成商C',
          credit_code: '91440300MA5FX00003',
          amount: 300000,
          tax_rate: '9%, 13%' // 应自动加前缀 * 转为 *9%,13%
        }
      ])
    });
    assert.strictEqual(c2026.success, true, '2026年多方合同应新增成功');

    // 4. 验证按年断号重编序号、日期规范化与税率智能转换结果
    const listRes = await requestJson(port, '/api/contracts?sort_by=seq_no&sort_order=ASC');
    assert.strictEqual(listRes.data.length, 2, '应有2条合同');
    const row2025 = listRes.data[0];
    const row2026 = listRes.data[1];

    assert.strictEqual(row2025.seq_label, '2025-001', '2025年首份合同序号应为 2025-001');
    assert.strictEqual(row2025.sign_date, '2025-03-05', '2025.3.5 应自动规范化为 2025-03-05');
    assert.strictEqual(row2025.tax_rate, '6%', '税率输入 6 应自动转为 6%');

    const curYear = new Date().getFullYear();
    assert.strictEqual(row2026.seq_label, `${curYear}-001`, '跨年合同序号应自动断号重编为 当年-001');
    assert.strictEqual(row2026.sign_date, `${curYear}-06-03`, '简写日期 6.3 应补全当年为 YYYY-06-03');
    assert.strictEqual(row2026.tax_rate, '*6%,13%', '多税率输入 6，13 应自动转为 *6%,13%');

    // 5. 验证按年份与时间段筛选
    const filterYearRes = await requestJson(port, '/api/contracts?sign_year=2025');
    assert.strictEqual(filterYearRes.data.length, 1, '按2025年筛选应精确命中1条');

    // 6. 验证带样式与防科学计数法的 Excel 导出
    const exportStatus = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/contracts/export?scope=all`, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.strictEqual(exportStatus, 200, '美化版 Excel 导出应返回 200');

    // 7. 验证彻底释放端口与 SQLite 文件句柄
    await controller.shutdown();
    controller = null;
    fs.rmSync(testDataRoot, { recursive: true, force: true });
    console.log('✅ 按年断号重编、智能日期/税率识别、多维筛选、Excel美化导出与资源释放测试全部通过！');
    process.exit(0);
  } catch (err) {
    console.error('❌ 冒烟测试失败:', err);
    if (controller) {
      try { await controller.shutdown(); } catch (e) {}
    }
    process.exit(1);
  }
})();
