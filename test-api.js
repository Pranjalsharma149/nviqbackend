const axios = require('axios');
const crypto = require('crypto');

const appId  = 'Naviq2102';
const secret = 'dp972p4kcd90fob3uxri5sjzvfz6d2lt';
const BASE   = 'https://open.iopgps.com';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  const time = Math.floor(Date.now() / 1000);
  const signature = md5(md5(secret) + time);
  
  const auth = await axios.post(`${BASE}/api/auth`,
    { appid: appId, time, signature },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  
  const token = auth.data.accessToken;
  console.log('✅ Token:', token);

  await sleep(2000);

  // Try device detail page with correct format from docs
  // docs showed: data is array of objects
  const attempts = [
    { pageNo: 1, pageSize: 20, data: [{ imei: '356218606576971' }] },
    { pageNo: 1, pageSize: 20, imei: '356218606576971' },
    { pageNo: 1, pageSize: 20, imeis: ['356218606576971'] },
    { pageNo: 1, pageSize: 20, data: [] },
    { pageSize: 20, pageNum: 1 },
  ];

  for (const body of attempts) {
    await sleep(1500);
    const res = await axios.post(
      `${BASE}/api/device/detail/page`,
      body,
      {
        params: { accessToken: token },
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    console.log(`\nBody: ${JSON.stringify(body)}`);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 400));
  }
}

run().catch(console.error);